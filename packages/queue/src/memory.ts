// In-process FIFO queue driver (SPEC §7): default for tests/dev.
// True FIFO with head-of-line blocking: a job is processed once its handler is
// registered, strictly in enqueue order. close() drains pending work.
//
// M3 #28 (additive): jobs are tracked for getJob() — state transitions
// queued → active → completed/failed — and a handler's return value is
// recorded as the job result. A throwing handler marks ITS job failed and the
// pump continues with the next job (previously the exception escaped pump();
// no existing behavior changes for non-throwing handlers).

import type { JobState, JobStatus } from './index.js';

interface Job {
  id: string;
  name: string;
  payload: unknown;
  state: JobState;
  progress: number;
  result?: unknown;
  error?: string;
}

export class MemoryQueue {
  private jobs: Job[] = [];
  private handlers = new Map<string, (payload: any) => Promise<unknown>>();
  private counter = 0;
  private pumping = false;
  private closed = false;
  private drainWaiters: Array<() => void> = [];
  /** All jobs ever enqueued (including completed/failed) for getJob(). */
  private records = new Map<string, Job>();

  async enqueue(name: string, payload: unknown): Promise<string> {
    if (this.closed) throw new Error('memory queue is closed');
    this.counter += 1;
    const id = `mem-${this.counter}`;
    const job: Job = { id, name, payload, state: 'queued', progress: 0 };
    this.jobs.push(job);
    this.records.set(id, job);
    void this.pump();
    return id;
  }

  registerHandler(name: string, fn: (payload: any) => Promise<unknown>): void {
    this.handlers.set(name, fn);
    void this.pump();
  }

  /** Number of jobs still waiting (pending or in-flight head). */
  get depth(): number {
    return this.jobs.length;
  }

  /** Status of any job this queue has seen (null when the id is unknown). */
  async getJob(id: string): Promise<JobStatus | null> {
    const job = this.records.get(id);
    if (!job) return null;
    const status: JobStatus = {
      id: job.id,
      name: job.name,
      state: job.state,
      progress: job.state === 'completed' ? 100 : job.progress,
      payload: job.payload,
    };
    if (job.result !== undefined) status.result = job.result;
    if (job.error !== undefined) status.error = job.error;
    return status;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.jobs.length > 0) {
        const head = this.jobs[0]!;
        const handler = this.handlers.get(head.name);
        if (!handler) break; // head-of-line blocking: wait for a handler
        this.jobs.shift();
        head.state = 'active';
        try {
          const result = await handler(head.payload);
          head.state = 'completed';
          head.progress = 100;
          head.result = result;
        } catch (error) {
          // Record the failure and keep draining — one bad job must not stall
          // the queue. (Additive M3 #28 behavior; see file header.)
          head.state = 'failed';
          head.error = error instanceof Error ? error.message : String(error);
        }
      }
    } finally {
      this.pumping = false;
      if (this.jobs.length === 0) {
        const waiters = this.drainWaiters.splice(0);
        for (const resolve of waiters) resolve();
      }
    }
  }

  async close(): Promise<void> {
    while (this.jobs.length > 0 || this.pumping) {
      await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
    }
    this.closed = true;
  }
}

export function createMemoryQueue(): MemoryQueue {
  return new MemoryQueue();
}
