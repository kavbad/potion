// KNOWN DEFECTS / PREMISE PINS for the queue drivers.
//
// F20, AS FILED, WAS WRONG AND IS CORRECTED HERE. The filing claimed the
// BullMQ durability test was a phantom proof. Reproducing it showed the
// limitation is disclosed in BOTH places that matter: the test is named
// "jobs survive a driver restart (NEW DRIVER, SAME DATA CONTEXT)", and
// testing/mock-redis.ts carries a DATA-SHARING NOTE spelling out that
// ioredis-mock shares one data context per host:port across every instance
// in the process. Nothing asserts a protection that does not exist, so this
// is not the phantom-decision pattern and gets no `it.fails` marker.
//
// What IS true, and all that survives of F20: no test anywhere crosses a
// real process boundary, so BullMQ persistence is UNVERIFIED — not falsely
// claimed. That is a coverage gap for docs/driver-semantics.md to carry, not
// a defect in this code.
//
// The test below PINS the premise rather than asserting a defect. If
// ioredis-mock ever isolates instances, the restart test would start passing
// for a different reason (or break); this makes that visible in one line
// instead of leaving a silently-changed premise underneath it.
import { describe, expect, it } from 'vitest';
import { createBullMqMockConnection } from './testing/mock-redis.js';

describe('queue driver premise: the ioredis-mock data context is process-shared', () => {
  it('two independent mock connections see each other — why the "restart" test is not a durability proof', async () => {
    const a = createBullMqMockConnection();
    const b = createBullMqMockConnection();
    const key = `premise-${process.pid}`;
    await a.set(key, 'written-by-a');
    // A genuinely separate Redis client would see nothing here.
    expect(await b.get(key)).toBe('written-by-a');
    await a.del(key);
    a.disconnect();
    b.disconnect();
  });
});
