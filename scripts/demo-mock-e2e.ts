// Gate 0 demo (SPEC §10): one fake request through the full mock pipeline —
// embedder → cluster assigner → strategy (single) → mock provider → response.
// Prints a readable trace. Deterministic (seeded), zero network, zero services.
import { fileURLToPath } from 'node:url';
import type { ChatMessage, StrategyConfig } from '@potion/core';
import { createProviders, loadPrices } from '@potion/providers';
import {
  centroidsFromTaxonomy,
  createAssigner,
  loadTaxonomy,
  type Embedder,
  type Taxonomy,
} from '@potion/cluster';
import { createResolver, execute } from '@potion/strategies';

const PRICES_PATH = fileURLToPath(new URL('../prices.json', import.meta.url));
const SEED = 20260804;

async function main(): Promise<void> {
  const prompt =
    process.argv[2] ?? 'Write a Python function that checks whether a string is a palindrome';
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are a concise, correct assistant.' },
    { role: 'user', content: prompt },
  ];

  console.log('── Potion Gate 0: mock end-to-end ──────────────────────────────');
  console.log(`prompt        : ${prompt}`);

  // 1. prices
  const { table: prices, stale } = loadPrices(PRICES_PATH);
  console.log(`prices        : v${prices.version} (${prices.entries.length} aliases)${stale ? ' [STALE]' : ''}`);

  // 2. providers (mock only; live stubs refuse without keys)
  const providers = createProviders({ prices });
  if (!providers.mock.embed) throw new Error('mock embedder missing');
  const embedder: Embedder = { embed: (t) => providers.mock.embed!(t) };

  // 3. cluster assignment: real taxonomy when data/taxonomy.json is present
  //    (Phase 2), else a small inline fixture so the Gate-0 demo still runs.
  const FALLBACK_TAXONOMY: Taxonomy = {
    version: 'demo-fallback',
    clusters: [
      {
        id: 'code-gen',
        name: 'Code generation',
        description: 'Write or fix code, functions, scripts, algorithms.',
        exemplars: [
          'Write a Python function that reverses a linked list',
          'Fix the bug in this JavaScript function',
          'Implement an algorithm to compile regex matches in code',
        ],
      },
      {
        id: 'extraction',
        name: 'Structured extraction',
        description: 'Extract fields/entities from text into JSON.',
        exemplars: [
          'Extract the invoice total and date as JSON',
          'Parse this email and extract all name fields into JSON',
          'Extract every entity mentioned in the contract as JSON',
        ],
      },
      {
        id: 'summarization',
        name: 'Summarization',
        description: 'Condense long text into brief summaries.',
        exemplars: [
          'Summarize this article in three sentences',
          'TL;DR of this meeting transcript',
          'Give me a brief summary of the quarterly report',
        ],
      },
    ],
  };
  let taxonomy: Taxonomy;
  try {
    taxonomy = loadTaxonomy();
    console.log(`taxonomy      : v${taxonomy.version} (${taxonomy.clusters.length} clusters, data/taxonomy.json)`);
  } catch {
    taxonomy = FALLBACK_TAXONOMY;
    console.log('taxonomy      : demo fallback (3 clusters; data/taxonomy.json not present)');
  }
  const centroids = await centroidsFromTaxonomy(taxonomy, embedder);
  const assigner = createAssigner(embedder, centroids);
  const assignment = await assigner.assign(prompt);
  console.log(
    `cluster       : ${assignment.clusterId} (confidence ${assignment.confidence.toFixed(4)})`,
  );

  // 4. strategy execution (single, seeded, streamed)
  const strategy: StrategyConfig = { type: 'single', model: 'mock-frontier' };
  const streamed: string[] = [];
  const result = await execute(strategy, messages, {
    providers,
    prices,
    resolve: createResolver(providers, prices),
    seed: SEED,
    stream: (token) => streamed.push(token),
  });
  const stage = result.trace[0]!;

  // 5. readable trace
  console.log('────────────────────────────────────────────────────────────────');
  console.log(`strategy      : single → ${stage.model}`);
  console.log(`stage usage   : ${stage.usage.inputTokens} in / ${stage.usage.outputTokens} out tokens`);
  console.log(`cost          : $${result.usage.costUsd.toFixed(6)} (mock pricing)`);
  console.log(`latency       : ${result.usage.latencyMs} ms (mock frontier profile)`);
  console.log(`confidence    : ${stage.confidence?.toFixed(4) ?? 'n/a'} (mock logprob)`);
  console.log(`stream        : ${streamed.length} chunks, reassembled === final text: ${streamed.join('') === result.text}`);
  console.log('────────────────────────────────────────────────────────────────');
  console.log(`response      : ${result.text.slice(0, 160)}${result.text.length > 160 ? '…' : ''}`);
  console.log('── Gate 0 demo OK ──────────────────────────────────────────────');
}

main().catch((err) => {
  console.error('demo-mock-e2e failed:', err);
  process.exit(1);
});
