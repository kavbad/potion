// G2.8 serve leg: sampled serving traffic so quality_samples exist, the
// derived serve floor is measured on real data, and the guarantee report
// renders entries. Boots the real server against the capstone db.
import { fileURLToPath } from 'node:url';
import { sha256 } from '@potion/core';
import { insertApiKey, insertPolicy, activeIncumbent } from '@potion/db';
import { buildServer } from '../../../apps/server/src/server.js';

const ORG = 'org_g28_capstone';
const CLUSTER = 'agent-2dfbfb-d8898a';
const RAW = 'pk_g28_serve_key';

async function main() {
  const app = await buildServer({ seed: false, pricesPath: fileURLToPath(new URL('../../../prices.json', import.meta.url)) });
  const db = app.potion.db.db;
  const inc = await activeIncumbent(db, ORG, CLUSTER);
  console.log('incumbent:', inc?.strategyHash.slice(0, 8) ?? 'NONE');

  try {
    await insertPolicy(db, {
      id: 'pol-g28-serve',
      orgId: ORG,
      name: 'g28-serve',
      // sampleRate 1 → every request judge-scores, so the window fills fast.
      config: {
        type: 'max_quality',
        costCeilingPer1K: 100,
        guarantee: { minQuality: 0.5, windowMin: 1440, sampleRate: 1, action: 'alert' },
      },
    });
    await insertApiKey(db, { id: 'key-g28-serve', keyHash: sha256(RAW), name: 'g28', orgId: ORG, policyId: 'pol-g28-serve' });
  } catch { /* idempotent on resume */ }

  const prompts = [
    'Summarise where the retention floor is defined and what gates it.',
    'Find the tool-signature bucketing rule and explain what it hashes.',
    'What does the suite-verify epsilon exclude, and why?',
    'Explain how the derived serve floor is computed from incumbent evidence.',
    'Which providers are reachable for a live sweep and how is that decided?',
    'Describe the cache-key components for a live eval row.',
  ];
  let ok = 0;
  for (const [i, content] of prompts.entries()) {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${RAW}`, 'content-type': 'application/json', 'x-potion-cluster': CLUSTER },
      payload: { model: 'potion-auto', messages: [{ role: 'user', content }] },
    });
    console.log(`chat ${i + 1}: ${res.statusCode} ${res.headers['x-frontier-trace'] ?? ''}`);
    if (res.statusCode === 200) ok += 1;
  }
  console.log(`served ${ok}/${prompts.length}`);
  // Judge sampling is fire-and-forget; give it room to land before closing.
  await new Promise((r) => setTimeout(r, 45_000));
  await app.close();
  console.log('SERVE LEG DONE');
}
void main().catch((e: unknown) => { console.error('SERVE LEG FAILED:', (e as Error).message); process.exit(1); });
