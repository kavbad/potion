// Queue contract (SPEC §7 + §12.2). Two drivers behind one interface:
//   · memory — in-process FIFO (default in tests/dev; zero services)
//   · bullmq — Redis-backed via BullMQ; jobs survive restarts, 3× retry w/
//     exponential backoff (see bullmq.ts)
//
// DRIVER SELECTION PRECEDENCE in createQueue (documented, M3 #28):
//   1. explicit `kind` argument (e.g. createQueue('bullmq', …)) — always wins;
//   2. QUEUE_DRIVER env ('memory' | 'bullmq') when kind is omitted;
//   3. REDIS_URL env set → 'bullmq' (SPEC §7: "bullmq used when REDIS_URL set");
//   4. default 'memory'.
// Redis URL resolution for the bullmq driver: opts.redisUrl (or the legacy
// second-positional string form) > REDIS_URL env > redis://localhost:6379.
import { MemoryQueue, createMemoryQueue } from './memory.js';
import { createBullMQQueue, type BullMQDriverOptions } from './bullmq.js';

/** Lifecycle states reported by getJob (driver-agnostic). */
export type JobState = 'queued' | 'active' | 'completed' | 'failed' | 'delayed' | 'unknown';

/** Point-in-time view of a job, e.g. for GET /api/jobs/:id (SPEC §12.2). */
export interface JobStatus {
  id: string;
  name: string;
  state: JobState;
  /** 0–100. 100 once completed (drivers only track handler-set progress). */
  progress: number;
  /** The enqueued payload (carries orgId for org-scoped job reads). */
  payload: unknown;
  /** Handler return value, once completed. */
  result?: unknown;
  /** Handler error message, once failed. */
  error?: string;
  /** Executions so far (1 on the first run). Exposed because retry
   * re-execution is a correctness concern for spend-bearing jobs, not just
   * an operational detail — F10. */
  attempts?: number;
}

/**
 * What a handler is told about the DELIVERY it is running under (F10).
 *
 * The job id is the only thing that distinguishes a queue RETRY from a
 * deliberate re-run: two suite-verify verdicts for the same tuple are
 * correct when a human asked twice, and a double-spend when the queue
 * redelivered once. Both drivers have this in hand at the call site and
 * used to discard it.
 */
export interface JobDelivery {
  jobId: string;
  /** 1 on first delivery; 2+ on a retry or a stall redelivery. */
  attempt: number;
}

/**
 * The queue contract (SPEC §7 `Queue`, renamed PotionQueue in §12.2).
 * registerHandler handlers MAY return a value: it is recorded as the job
 * result and surfaced via getJob (memory) / BullMQ returnvalue (bullmq).
 */
export interface PotionQueue {
  enqueue(name: string, payload: unknown): Promise<string>;
  /** The handler receives the delivery context as a second argument; drivers
   * MUST supply it (F10 — see JobDelivery). */
  registerHandler(
    name: string,
    fn: (payload: any, delivery: JobDelivery) => Promise<unknown>,
  ): void;
  /** Status lookup for the jobs endpoint; null when the id is unknown. */
  getJob(id: string): Promise<JobStatus | null>;
  close(): Promise<void>;
}

/** Back-compat alias — SPEC §7 named the interface `Queue`. */
export type Queue = PotionQueue;

export type QueueKind = 'memory' | 'bullmq';

export type CreateQueueOptions = BullMQDriverOptions;

/**
 * Create a queue driver. Accepts either the §7 legacy form
 * createQueue(kind, redisUrlString) or the §12.2 form
 * createQueue(kind, { redisUrl, connection, … }).
 */
export function createQueue(kind?: QueueKind, opts?: CreateQueueOptions | string): PotionQueue {
  const options: CreateQueueOptions = typeof opts === 'string' ? { redisUrl: opts } : (opts ?? {});
  const effectiveKind: QueueKind =
    kind ??
    (process.env.QUEUE_DRIVER === 'bullmq' || process.env.QUEUE_DRIVER === 'memory'
      ? process.env.QUEUE_DRIVER
      : process.env.REDIS_URL
        ? 'bullmq'
        : 'memory');
  switch (effectiveKind) {
    case 'memory':
      return createMemoryQueue();
    case 'bullmq':
      return createBullMQQueue(options);
  }
}

export { MemoryQueue, createMemoryQueue };
export {
  BullMQPotionQueue,
  QueueUnavailableError,
  createBullMQQueue,
  DEFAULT_QUEUE_NAME,
  DEFAULT_REDIS_URL,
  type BullMQDriverOptions,
} from './bullmq.js';
