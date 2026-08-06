// BYOK demo (M2 Wave 2, ROADMAP #15/#16) — run with tsx from apps/server:
//   pnpm tsx /tmp/byok-demo.ts
// Org registers a provider key → chat is served using the ORG key (evidence
// via an injected provider-factory spy) → rotate → revoke → custody_audit.
import { sha256, type Policy, type ProviderId } from '@potion/core';
import {
  DEFAULT_ORG_ID,
  insertApiKey,
  insertPolicy,
  listCustodyAudit,
} from '@potion/db';
import type { Provider, ProviderFactoryOptions } from '@potion/providers';
import { buildServer } from './src/server.js';

const RAW_PLATFORM = 'pk_demo_platform_key';
const POLICY: Policy = { type: 'max_quality', costCeilingPer1K: 100 };
const BYOK_RAW_V1 = 'sk-demo-org-key-V1-0123456789abcdef';
const BYOK_RAW_V2 = 'sk-demo-org-key-V2-fedcba9876543210';

const factoryCalls: Array<Partial<Record<ProviderId, string>>> = [];
function spyFactory(opts: ProviderFactoryOptions): Record<ProviderId, Provider> {
  factoryCalls.push({ ...(opts.apiKeys ?? {}) });
  const make = (id: ProviderId): Provider => ({
    id,
    complete: async (req) => ({
      text: `[served by ${id} key: ${opts.apiKeys?.[id] ?? '(none)'}] echo of “${req.messages.at(-1)?.content}”`,
      usage: { inputTokens: 4, outputTokens: 9 },
      latencyMs: 1,
      modelVersion: 'spy-v1',
    }),
  });
  return {
    anthropic: make('anthropic'),
    openai: make('openai'),
    google: make('google'),
    openrouter: make('openrouter'),
    mock: make('mock'),
  };
}

const app = await buildServer({ seed: false, providerFactory: spyFactory, log: (m) => console.log(`  boot: ${m}`) });
const db = app.potion.db.db;

await insertPolicy(db, { id: 'pol-demo', orgId: DEFAULT_ORG_ID, name: 'demo', config: POLICY });
await insertApiKey(db, {
  id: 'key-demo',
  keyHash: sha256(RAW_PLATFORM),
  name: 'demo serving key',
  orgId: DEFAULT_ORG_ID,
  policyId: 'pol-demo',
});

const chat = () =>
  app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${RAW_PLATFORM}`, 'content-type': 'application/json' },
    payload: { model: 'potion-auto', messages: [{ role: 'user', content: 'Say hi' }] },
  });

console.log('\n=== 1. BEFORE BYOK: chat served by the PLATFORM boot providers ===');
let res = await chat();
console.log('  response:', res.json().choices[0].message.content.slice(0, 80), '…');
console.log('  org-key factory calls so far:', factoryCalls.length);

console.log('\n=== 2. Register org provider key (POST /api/keys) ===');
const reg = await app.inject({
  method: 'POST',
  url: '/api/keys',
  headers: { 'content-type': 'application/json' },
  payload: { provider: 'mock', apiKey: BYOK_RAW_V1, name: 'demo byok' },
});
console.log('  status:', reg.statusCode, '→', JSON.stringify(reg.json(), null, 2).replaceAll('\n', '\n  '));
const keyId = reg.json().id as string;

console.log('\n=== 3. AFTER BYOK: chat served using the ORG key (spy evidence) ===');
res = await chat();
console.log('  response:', res.json().choices[0].message.content);
console.log('  factory received apiKeys:', factoryCalls.at(-1));
console.log('  → org key USED for serving:', factoryCalls.at(-1)?.mock === BYOK_RAW_V1);

console.log('\n=== 4. Validate (probe through provider with DECRYPTED key) ===');
const val = await app.inject({ method: 'POST', url: `/api/keys/${keyId}/validate` });
console.log('  status:', val.statusCode, '→', JSON.stringify(val.json()));

console.log('\n=== 5. Rotate (POST /api/keys/:id/rotate) → serving follows immediately ===');
const rot = await app.inject({
  method: 'POST',
  url: `/api/keys/${keyId}/rotate`,
  headers: { 'content-type': 'application/json' },
  payload: { apiKey: BYOK_RAW_V2 },
});
console.log('  status:', rot.statusCode, '→ keyVersion:', rot.json().keyVersion, 'masked:', rot.json().maskedKey);
res = await chat();
console.log('  response:', res.json().choices[0].message.content);
console.log('  → rotated key USED:', factoryCalls.at(-1)?.mock === BYOK_RAW_V2);

console.log('\n=== 6. Revoke (POST /api/keys/:id/revoke) → serving stops IMMEDIATELY ===');
const rev = await app.inject({ method: 'POST', url: `/api/keys/${keyId}/revoke` });
console.log('  status:', rev.statusCode, '→ status:', rev.json().status, 'servingEnabled:', rev.json().servingEnabled);
const callsBefore = factoryCalls.length;
res = await chat();
console.log('  response:', res.json().choices[0].message.content.slice(0, 80), '…');
console.log('  org-key factory calls during that request:', factoryCalls.length - callsBefore, '(0 = platform fallback, revoke is instant)');

console.log('\n=== 7. custody_audit trail for the key ===');
const audit = await listCustodyAudit(db, DEFAULT_ORG_ID, keyId);
for (const a of [...audit].reverse()) {
  console.log(`  ${a.createdAt.toISOString()}  ${a.action.padEnd(8)} actor=${a.actor.padEnd(16)} ${JSON.stringify(a.metadata)}`);
}

await app.close();
console.log('\nDEMO OK');
