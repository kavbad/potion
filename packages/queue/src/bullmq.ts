// BullMQ queue driver (SPEC §12.2): same PotionQueue interface as the memory
// driver, backed by Redis. Jobs survive worker/driver restarts (they live in
// Redis, not the process); every enqueued job is configured with 3 attempts
// and exponential backoff by default. Tests run hermetically against
// ioredis-mock via src/testing/ (a caller-provided `connection`).
import { Queue as BullQueue, Worker as BullWorker, type Job, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import type { JobState, JobStatus, PotionQueue } from './index.js';

/** Default Redis endpoint when neither opts.redisUrl nor REDIS_URL is set. */
export const DEFAULT_REDIS_URL = 'redis://localhost:6379';

/** Default BullMQ queue name (all Potion job kinds share one queue; the
 * PotionQueue `name` maps to the BullMQ job name). */
export const DEFAULT_QUEUE_NAME = 'potion';

/** Retry policy (SPEC §12.2: "retries w/ backoff 3×"). */
export const DEFAULT_ATTEMPTS = 3;

/**
 * F10: job kinds that SPEND a customer's money get ONE attempt.
 *
 * Blindly re-running a job that bought provider tokens is the wrong default:
 * three of these re-spend IN FULL on a retry (suite:certify and
 * research:cycle pass no `resume`; rubric:generate has no cache at all), and
 * a retry also re-enters contractual branches whose preconditions the first
 * attempt already mutated. These kinds already have DELIBERATE
 * application-level retry — the G2.2 sweep re-enqueues stale advisories with
 * its own throttle and ledger — which is a better retry than a blind one.
 * The delivery guard (workers: withDeliveryGuard) still covers the stalled-
 * job redelivery that no attempt limit can prevent.
 */
export const SINGLE_ATTEMPT_KINDS: ReadonlySet<string> = new Set([
  'guarantee:suite-verify',
  'suite:certify',
  'frontier:live-sweep',
  'frontier:platform-sweep',
  'research:cycle',
  'rubric:generate',
]);
export const DEFAULT_BACKOFF_MS = 250;

/**
 * Thrown when the Redis backing the bullmq driver is unreachable or a queue
 * operation fails at the connection layer. `cause` carries the underlying
 * error; the message never embeds credentials (the URL is redacted).
 */
export class QueueUnavailableError extends Error {
  constructor(
    message: string,
    public readonly redisUrl: string,
    options?: { cause?: unknown },
  ) {
    super(`${message} (redis: ${redactUrl(redisUrl)})`, options);
    this.name = 'QueueUnavailableError';
  }
}

/** Strip any user:password@ credentials from a Redis URL for safe messages. */
function redactUrl(url: string): string {
  return url.replace(/\/\/[^/@]*@/, '//***@');
}

export interface BullMQDriverOptions {
  /** Redis URL. Falls back to REDIS_URL env, then DEFAULT_REDIS_URL. */
  redisUrl?: string;
  /**
   * Caller-provided ioredis(-compatible) connection — the test seam
   * (ioredis-mock via src/testing/createBullMqMockConnection). The driver
   * NEVER closes a caller-provided connection on close().
   */
  connection?: Redis;
  /** Extra ioredis options when the driver creates the connection itself
   * (e.g. { retryStrategy: () => null } to fail fast in tests). Ignored when
   * `connection` is provided. */
  connectionOptions?: Record<string, unknown>;
  /** BullMQ queue name (default 'potion'); tests use unique names because
   * ioredis-mock shares one data context per host:port process-wide. */
  queueName?: string;
  /** Job attempts (default 3). */
  attempts?: number;
  /** Backoff base delay in ms, exponential ×2 (default 250). */
  backoffMs?: number;
}

type Handler = (payload: any, delivery: { jobId: string; attempt: number }) => Promise<unknown>;

/** Map a BullMQ job state to the driver-level JobState. */
function toJobState(bullState: string): JobState {
  switch (bullState) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'active':
      return 'active';
    case 'delayed':
      return 'delayed';
    case 'waiting':
    case 'prioritized':
    case 'waiting-children':
      return 'queued';
    default:
      return 'unknown';
  }
}

async function toJobStatus(job: Job): Promise<JobStatus> {
  const state = toJobState(await job.getState());
  const status: JobStatus = {
    id: String(job.id),
    name: job.name,
    state,
    progress: state === 'completed' ? 100 : typeof job.progress === 'number' ? job.progress : 0,
    payload: job.data,
    // F10: attemptsMade is 0 before the first run completes; report the
    // execution count the same way the memory driver does.
    attempts: (job.attemptsMade ?? 0) === 0 && state === 'active' ? 1 : (job.attemptsMade ?? 0),
  };
  if (job.returnvalue !== undefined && job.returnvalue !== null) status.result = job.returnvalue;
  if (job.failedReason !== undefined && job.failedReason !== null) status.error = job.failedReason;
  return status;
}

/**
 * BullMQ-backed PotionQueue. The BullMQ Worker is created lazily on the first
 * registerHandler call, so a producer-only driver never opens a blocking
 * connection. close() drains the worker (in-flight handlers finish).
 */
export class BullMQPotionQueue implements PotionQueue {
  private readonly queue: BullQueue;
  private worker: BullWorker | null = null;
  private readonly handlers = new Map<string, Handler>();
  private readonly connection: Redis;
  private readonly ownsConnection: boolean;
  private readonly redisUrl: string;
  private readonly jobDefaults: JobsOptions;
  private closed = false;

  constructor(options: BullMQDriverOptions = {}) {
    this.redisUrl = options.redisUrl ?? process.env.REDIS_URL ?? DEFAULT_REDIS_URL;
    if (options.connection) {
      this.connection = options.connection;
      this.ownsConnection = false;
    } else {
      this.connection = new Redis(this.redisUrl, {
        // BullMQ requirement for blocking worker connections.
        maxRetriesPerRequest: null,
        ...(options.connectionOptions ?? {}),
      });
      this.ownsConnection = true;
    }
    this.jobDefaults = {
      attempts: options.attempts ?? DEFAULT_ATTEMPTS,
      backoff: { type: 'exponential', delay: options.backoffMs ?? DEFAULT_BACKOFF_MS },
    };
    this.queue = new BullQueue(options.queueName ?? DEFAULT_QUEUE_NAME, {
      connection: this.connection,
    });
  }

  async enqueue(name: string, payload: unknown): Promise<string> {
    if (this.closed) throw new Error('bullmq queue is closed');
    try {
      const job = await this.queue.add(name, payload as object, {
        ...this.jobDefaults,
        ...(SINGLE_ATTEMPT_KINDS.has(name) ? { attempts: 1 } : {}),
      });
      return String(job.id);
    } catch (error) {
      throw new QueueUnavailableError('enqueue failed — Redis unreachable or closed', this.redisUrl, {
        cause: error,
      });
    }
  }

  registerHandler(name: string, fn: Handler): void {
    if (this.closed) throw new Error('bullmq queue is closed');
    this.handlers.set(name, fn);
    this.ensureWorker();
  }

  private ensureWorker(): void {
    if (this.worker) return;
    this.worker = new BullWorker(
      this.queue.name,
      async (job: Job) => {
        const handler = this.handlers.get(job.name);
        if (!handler) throw new Error(`no handler registered for job '${job.name}'`);
        // The handler's return value becomes the BullMQ returnvalue — this is
        // what getJob().result surfaces (e.g. RunSummary for eval:run).
        // F10: forward the DELIVERY context. `job.id` and `job.attemptsMade`
        // were already in scope here and discarded, which is why no handler
        // could tell a retry from a first run — and therefore why a retry
        // re-spent. attemptsMade is 0-based on the first execution.
        return handler(job.data, { jobId: String(job.id), attempt: (job.attemptsMade ?? 0) + 1 });
      },
      { connection: this.connection },
    );
    // Worker-level errors (connection drops between jobs etc.) are logged via
    // the 'error' event; BullMQ keeps reconnecting. Swallow nothing — but do
    // not crash the process on a background worker error either.
    this.worker.on('error', () => {});
  }

  async getJob(id: string): Promise<JobStatus | null> {
    try {
      const job = await this.queue.getJob(id);
      if (!job) return null;
      return await toJobStatus(job);
    } catch (error) {
      throw new QueueUnavailableError('getJob failed — Redis unreachable or closed', this.redisUrl, {
        cause: error,
      });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
    await this.queue.close();
    if (this.ownsConnection) this.connection.disconnect();
  }
}

export function createBullMQQueue(options: BullMQDriverOptions = {}): BullMQPotionQueue {
  return new BullMQPotionQueue(options);
}
