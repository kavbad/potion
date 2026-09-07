// In-process FIFO queue driver (SPEC §7): default for tests/dev.
//
// SEMANTIC PARITY (F10): this driver defaults to ONE execution per job,
// while the production bullmq driver retries 3× (SPEC.md §12.2 states that
// as the contract). That divergence hid a critical defect — handlers are not
// idempotent, so a retry re-spends — because every hermetic test uses this
// driver and no test could execute a handler twice. Pass `{attempts: N}` to
// model production. See docs/driver-semantics.md for the full audit of
// where each swapped driver diverges, and queue.test.ts for the parity test
// that now pins the agreement.
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
  /** Executions so far. 0 until the first run starts. */
  attempts: number;
}

/** Options (F10). `attempts` makes the driver able to EXPRESS production's
 * retry semantics — see the class doc. */
export interface MemoryQueueOptions {
  /** Max executions per job (default 1 — the historical behavior). SPEC
   * §12.2 specifies 3 for the production driver. */
  attempts?: number;
}

export class MemoryQueue {
  private jobs: Job[] = [];
  private handlers = new Map<
    string,
    (payload: any, delivery: { jobId: string; attempt: number }) => Promise<unknown>
  >();
  private counter = 0;
  private readonly maxAttempts: number;
  private pumping = false;
  private closed = false;
  private drainWaiters: Array<() => void> = [];
  /** All jobs ever enqueued (including completed/failed) for getJob(). */
  private records = new Map<string, Job>();

  constructor(opts: MemoryQueueOptions = {}) {
    this.maxAttempts = opts.attempts ?? 1;
  }

  async enqueue(name: string, payload: unknown): Promise<string> {
    if (this.closed) throw new Error('memory queue is closed');
    this.counter += 1;
    const id = `mem-${this.counter}`;
    const job: Job = { id, name, payload, state: 'queued', progress: 0, attempts: 0 };
    this.jobs.push(job);
    this.records.set(id, job);
    void this.pump();
    return id;
  }

  /**
   * P1-3 liveness, memory driver. A process-local queue is consumed by the
   * process that owns it and nobody else, so "is anything consuming" reduces
   * to "has anything registered a handler". It can still be 0 with jobs
   * waiting: a server built with POTION_WORKER=off registers none.
   */
  async consumerHealth(): Promise<{ waiting: number; consumers: number }> {
    return {
      waiting: this.jobs.filter((j) => j.state === 'queued').length,
      consumers: this.handlers.size > 0 ? 1 : 0,
    };
  }

  registerHandler(
    name: string,
    fn: (payload: any, delivery: { jobId: string; attempt: number }) => Promise<unknown>,
  ): void {
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
      attempts: job.attempts,
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
        head.attempts += 1;
        try {
          const result = await handler(head.payload, { jobId: head.id, attempt: head.attempts });
          head.state = 'completed';
          head.progress = 100;
          head.result = result;
        } catch (error) {
          head.error = error instanceof Error ? error.message : String(error);
          // F10: RETRY, when configured. This driver used to fail a throwing
          // job permanently while production (bullmq) retried it 3× — so no
          // hermetic test could ever execute a handler twice, and the
          // double-spend defect was not merely untested but INEXPRESSIBLE.
          // Re-queued at the TAIL (bullmq's backoff likewise reorders a
          // failing job behind its siblings) so one poison job cannot spin.
          if (head.attempts < this.maxAttempts) {
            head.state = 'queued';
            this.jobs.push(head);
          } else {
            head.state = 'failed';
          }
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

  /**
   * Drain, then close. Waits only for work that CAN drain.
   *
   * It used to wait on `this.jobs.length > 0`, and `pump()` stops at the head
   * of the line when that job's name has no handler — deliberately, so a
   * handler registered later still gets its jobs. Put those two together and
   * a queue holding one undeliverable job never drains and `close()` never
   * returns: the process hangs on shutdown until something kills it.
   *
   * Reachable the moment the two halves of Potion are split (P1-3): a server
   * built with POTION_WORKER=off registers no handlers, so EVERY job it
   * accepts is undeliverable in-process. The boot gate refuses that pairing
   * with the memory driver in a deployment, but an embedder or a test that
   * injects its own queue walks straight into it — which is how this was
   * found, by a test hanging for 60 seconds.
   *
   * Close is terminal: nobody registers a handler during it, so a job with no
   * handler now will never have one, and waiting for it is waiting forever.
   */
  private drainableJobs(): number {
    return this.jobs.filter((j) => this.handlers.has(j.name)).length;
  }

  async close(): Promise<void> {
    while (this.drainableJobs() > 0 || this.pumping) {
      await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
    }
    this.closed = true;
  }
}

export function createMemoryQueue(): MemoryQueue {
  return new MemoryQueue();
}
