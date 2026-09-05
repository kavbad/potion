// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Produced by scripts/gen-landing-evidence.ts from the committed baseline at
// packages/db/baseline/platform-frontiers.json. Every number below is a real
// measurement; the withheld winner's name is masked here, at the source, so
// it cannot reach the DOM. Regenerate after any campaign that republishes
// the baseline:
//
//   pnpm --filter @potion/dashboard gen:evidence
//
// test/landing-evidence.test.ts fails if this file and the baseline disagree,
// if a withheld name appears, or if the landing's evidence goes stale past
// the freshness window.

export interface LandingPoint {
  label: string;
  vendor: string;
  masked: boolean;
  hash8: string;
  quality: number;
  ci: number;
  costPer1K: number;
  p95Ms: number;
}

export interface LandingCluster {
  version: number;
  /** The day the frontier that produced these points was created. */
  measuredAt: string;
  suiteId: string;
  /** Distinct suite items, or null when the suite is not on disk. */
  items: number | null;
  /** Graded cells behind each point (items x repeats). */
  gradedCells: number;
  points: LandingPoint[];
}

/** Where these numbers come from, said on the page wherever they are shown. */
export const BASELINE_META = {
  source: 'packages/db/baseline/platform-frontiers.json',
  capturedAt: "2026-09-03",
  pricesVersion: "2026-08-04-or2+tranche-2026-08-19",
  providerMode: "live",
  /** The most recent frontier in the baseline — what "how fresh is this" means. */
  newestMeasuredAt: "2026-09-03",
} as const;

/** Every published cluster frontier, cheapest point first. */
export const CLUSTERS: Record<string, LandingCluster> = {
  "agentic-tool-use": {
    "version": 3,
    "measuredAt": "2026-08-20",
    "suiteId": "agentic-tool-use",
    "items": null,
    "gradedCells": 14,
    "points": [
      {
        "label": "or-gemini-flash",
        "vendor": "Google",
        "masked": false,
        "hash8": "41a39732",
        "quality": 0.8929,
        "ci": 0.0952,
        "costPer1K": 6.4324,
        "p95Ms": 5160
      },
      {
        "label": "or-gpt-mini",
        "vendor": "OpenAI",
        "masked": false,
        "hash8": "4e2fc860",
        "quality": 0.9071,
        "ci": 0.0665,
        "costPer1K": 6.5689,
        "p95Ms": 15054
      },
      {
        "label": "or-████████████",
        "vendor": "name withheld",
        "masked": true,
        "hash8": "220a2558",
        "quality": 0.9429,
        "ci": 0.0607,
        "costPer1K": 7.1944,
        "p95Ms": 34912
      },
      {
        "label": "or-gemini-3.7-flash",
        "vendor": "Google",
        "masked": false,
        "hash8": "ffe46bc9",
        "quality": 0.9571,
        "ci": 0.0446,
        "costPer1K": 11.7154,
        "p95Ms": 12489
      },
      {
        "label": "or-gpt-full",
        "vendor": "OpenAI",
        "masked": false,
        "hash8": "819f1ab8",
        "quality": 0.9571,
        "ci": 0.0396,
        "costPer1K": 13.7965,
        "p95Ms": 10669
      },
      {
        "label": "or-gpt-5.6-terra-pro",
        "vendor": "OpenAI",
        "masked": false,
        "hash8": "649924ca",
        "quality": 0.9714,
        "ci": 0.038,
        "costPer1K": 45.4076,
        "p95Ms": 34671
      }
    ]
  },
  "classification": {
    "version": 4,
    "measuredAt": "2026-08-21",
    "suiteId": "classification-hard-v1",
    "items": 30,
    "gradedCells": 80,
    "points": [
      {
        "label": "or-████████████",
        "vendor": "name withheld",
        "masked": true,
        "hash8": "220a2558",
        "quality": 0.975,
        "ci": 0.0344,
        "costPer1K": 0.0041,
        "p95Ms": 3489
      },
      {
        "label": "or-deepseek-v4-flash-0731",
        "vendor": "DeepSeek",
        "masked": false,
        "hash8": "1fd419ee",
        "quality": 0.9875,
        "ci": 0.0245,
        "costPer1K": 0.0201,
        "p95Ms": 10645
      },
      {
        "label": "or-gemini-flash",
        "vendor": "Google",
        "masked": false,
        "hash8": "41a39732",
        "quality": 0.9875,
        "ci": 0.0245,
        "costPer1K": 0.0263,
        "p95Ms": 1080
      },
      {
        "label": "or-gpt-mini",
        "vendor": "OpenAI",
        "masked": false,
        "hash8": "4e2fc860",
        "quality": 0.9875,
        "ci": 0.0245,
        "costPer1K": 0.0354,
        "p95Ms": 1053
      },
      {
        "label": "or-gemini-3.7-flash",
        "vendor": "Google",
        "masked": false,
        "hash8": "ffe46bc9",
        "quality": 1,
        "ci": 0,
        "costPer1K": 0.358,
        "p95Ms": 3367
      },
      {
        "label": "or-opus",
        "vendor": "Anthropic",
        "masked": false,
        "hash8": "10b2d052",
        "quality": 1,
        "ci": 0,
        "costPer1K": 0.5378,
        "p95Ms": 2132
      }
    ]
  },
  "code-gen": {
    "version": 4,
    "measuredAt": "2026-08-21",
    "suiteId": "code-gen-hard-v1",
    "items": 30,
    "gradedCells": 90,
    "points": [
      {
        "label": "or-████████████",
        "vendor": "name withheld",
        "masked": true,
        "hash8": "220a2558",
        "quality": 0.9785,
        "ci": 0.0199,
        "costPer1K": 0.0231,
        "p95Ms": 15351
      },
      {
        "label": "or-ling-3.0-flash",
        "vendor": "inclusionAI",
        "masked": false,
        "hash8": "e4263e18",
        "quality": 0.5759,
        "ci": 0.1024,
        "costPer1K": 0.1232,
        "p95Ms": 12731
      },
      {
        "label": "or-deepseek",
        "vendor": "DeepSeek",
        "masked": false,
        "hash8": "6efe8a56",
        "quality": 0.98,
        "ci": 0.0166,
        "costPer1K": 0.1904,
        "p95Ms": 15110
      },
      {
        "label": "or-nemotron-3.5-lightning",
        "vendor": "NVIDIA",
        "masked": false,
        "hash8": "238db164",
        "quality": 0.7017,
        "ci": 0.0933,
        "costPer1K": 0.2157,
        "p95Ms": 12943
      },
      {
        "label": "or-gpt-mini",
        "vendor": "OpenAI",
        "masked": false,
        "hash8": "4e2fc860",
        "quality": 0.99,
        "ci": 0.0113,
        "costPer1K": 0.2509,
        "p95Ms": 4383
      },
      {
        "label": "or-gemini-flash",
        "vendor": "Google",
        "masked": false,
        "hash8": "41a39732",
        "quality": 0.9961,
        "ci": 0.0045,
        "costPer1K": 0.5506,
        "p95Ms": 2372
      },
      {
        "label": "or-grok-4.6",
        "vendor": "xAI",
        "masked": false,
        "hash8": "e0a2f554",
        "quality": 1,
        "ci": 0,
        "costPer1K": 6.2568,
        "p95Ms": 44582
      }
    ]
  },
  "code-review": {
    "version": 6,
    "measuredAt": "2026-09-03",
    "suiteId": "code-review-hard-v1",
    "items": 28,
    "gradedCells": 63,
    "points": [
      {
        "label": "or-ling-3.0-flash",
        "vendor": "inclusionAI",
        "masked": false,
        "hash8": "e4263e18",
        "quality": 0.8143,
        "ci": 0.1089,
        "costPer1K": 1.2644,
        "p95Ms": 61432
      },
      {
        "label": "or-gpt-mini",
        "vendor": "OpenAI",
        "masked": false,
        "hash8": "4e2fc860",
        "quality": 0.9086,
        "ci": 0.084,
        "costPer1K": 1.5842,
        "p95Ms": 5082
      },
      {
        "label": "or-gemini-flash",
        "vendor": "Google",
        "masked": false,
        "hash8": "41a39732",
        "quality": 0.7943,
        "ci": 0.1054,
        "costPer1K": 2.5043,
        "p95Ms": 4726
      },
      {
        "label": "or-haiku",
        "vendor": "Anthropic",
        "masked": false,
        "hash8": "88ed8b9c",
        "quality": 0.9171,
        "ci": 0.0816,
        "costPer1K": 2.8119,
        "p95Ms": 4355
      },
      {
        "label": "or-gpt-full",
        "vendor": "OpenAI",
        "masked": false,
        "hash8": "819f1ab8",
        "quality": 0.9529,
        "ci": 0.069,
        "costPer1K": 3.159,
        "p95Ms": 4631
      }
    ]
  },
  "creative": {
    "version": 3,
    "measuredAt": "2026-08-21",
    "suiteId": "creative",
    "items": null,
    "gradedCells": 14,
    "points": [
      {
        "label": "or-ling-3.0-flash",
        "vendor": "inclusionAI",
        "masked": false,
        "hash8": "e4263e18",
        "quality": 0.4286,
        "ci": 0.2236,
        "costPer1K": 3.8959,
        "p95Ms": 43146
      },
      {
        "label": "or-laguna-s-2.1",
        "vendor": "Poolside",
        "masked": false,
        "hash8": "2e70d6e2",
        "quality": 0.5571,
        "ci": 0.1691,
        "costPer1K": 3.9706,
        "p95Ms": 23248
      },
      {
        "label": "or-deepseek",
        "vendor": "DeepSeek",
        "masked": false,
        "hash8": "6efe8a56",
        "quality": 0.8214,
        "ci": 0.0852,
        "costPer1K": 4.0105,
        "p95Ms": 22494
      },
      {
        "label": "or-nemotron-3.5-lightning",
        "vendor": "NVIDIA",
        "masked": false,
        "hash8": "238db164",
        "quality": 0.4286,
        "ci": 0.1854,
        "costPer1K": 4.0719,
        "p95Ms": 15060
      },
      {
        "label": "or-haiku",
        "vendor": "Anthropic",
        "masked": false,
        "hash8": "88ed8b9c",
        "quality": 0.7429,
        "ci": 0.1278,
        "costPer1K": 4.9024,
        "p95Ms": 7786
      },
      {
        "label": "or-gemini-flash",
        "vendor": "Google",
        "masked": false,
        "hash8": "41a39732",
        "quality": 0.7857,
        "ci": 0.1141,
        "costPer1K": 5.2254,
        "p95Ms": 3156
      },
      {
        "label": "or-gpt-full",
        "vendor": "OpenAI",
        "masked": false,
        "hash8": "819f1ab8",
        "quality": 0.8286,
        "ci": 0.1016,
        "costPer1K": 5.5725,
        "p95Ms": 6012
      },
      {
        "label": "or-gpt-mini",
        "vendor": "OpenAI",
        "masked": false,
        "hash8": "4e2fc860",
        "quality": 0.7929,
        "ci": 0.0906,
        "costPer1K": 5.7032,
        "p95Ms": 4978
      },
      {
        "label": "or-sonnet",
        "vendor": "Anthropic",
        "masked": false,
        "hash8": "07b4dc72",
        "quality": 0.9071,
        "ci": 0.0323,
        "costPer1K": 7.56,
        "p95Ms": 9464
      }
    ]
  },
  "extraction": {
    "version": 6,
    "measuredAt": "2026-09-03",
    "suiteId": "extraction-hard-v2",
    "items": 40,
    "gradedCells": 261,
    "points": [
      {
        "label": "or-████████████",
        "vendor": "name withheld",
        "masked": true,
        "hash8": "220a2558",
        "quality": 0.9497,
        "ci": 0.0316,
        "costPer1K": 0.0216,
        "p95Ms": 11097
      },
      {
        "label": "or-deepseek",
        "vendor": "DeepSeek",
        "masked": false,
        "hash8": "6efe8a56",
        "quality": 0.9504,
        "ci": 0.0315,
        "costPer1K": 0.1846,
        "p95Ms": 11344
      },
      {
        "label": "or-gpt-mini",
        "vendor": "OpenAI",
        "masked": false,
        "hash8": "4e2fc860",
        "quality": 0.9454,
        "ci": 0.0326,
        "costPer1K": 0.2537,
        "p95Ms": 2990
      },
      {
        "label": "or-gemini-flash",
        "vendor": "Google",
        "masked": false,
        "hash8": "41a39732",
        "quality": 0.947,
        "ci": 0.0322,
        "costPer1K": 0.3343,
        "p95Ms": 1379
      },
      {
        "label": "or-inkling-small",
        "vendor": "Thinking Machines",
        "masked": false,
        "hash8": "07c9d6a7",
        "quality": 0.9733,
        "ci": 0.0251,
        "costPer1K": 0.5931,
        "p95Ms": 14420
      },
      {
        "label": "or-gpt-full",
        "vendor": "OpenAI",
        "masked": false,
        "hash8": "819f1ab8",
        "quality": 0.9486,
        "ci": 0.0319,
        "costPer1K": 1.2921,
        "p95Ms": 2536
      },
      {
        "label": "or-gemini-3.7-flash",
        "vendor": "Google",
        "masked": false,
        "hash8": "ffe46bc9",
        "quality": 0.9587,
        "ci": 0.0294,
        "costPer1K": 1.6493,
        "p95Ms": 10919
      },
      {
        "label": "or-inkling",
        "vendor": "Thinking Machines",
        "masked": false,
        "hash8": "8ad63a4e",
        "quality": 0.9771,
        "ci": 0.0237,
        "costPer1K": 1.7633,
        "p95Ms": 6668
      },
      {
        "label": "or-opus",
        "vendor": "Anthropic",
        "masked": false,
        "hash8": "10b2d052",
        "quality": 0.9782,
        "ci": 0.0233,
        "costPer1K": 3.6813,
        "p95Ms": 3214
      }
    ]
  },
  "multi-step-reasoning": {
    "version": 3,
    "measuredAt": "2026-08-20",
    "suiteId": "multi-step-reasoning",
    "items": null,
    "gradedCells": 50,
    "points": [
      {
        "label": "or-████████████",
        "vendor": "name withheld",
        "masked": true,
        "hash8": "220a2558",
        "quality": 0.5,
        "ci": 0.14,
        "costPer1K": 0.0093,
        "p95Ms": 7160
      },
      {
        "label": "or-deepseek-v4-flash-0731",
        "vendor": "DeepSeek",
        "masked": false,
        "hash8": "1fd419ee",
        "quality": 0.98,
        "ci": 0.0392,
        "costPer1K": 0.0304,
        "p95Ms": 9702
      },
      {
        "label": "or-nemotron-3.5-lightning",
        "vendor": "NVIDIA",
        "masked": false,
        "hash8": "238db164",
        "quality": 0.76,
        "ci": 0.1196,
        "costPer1K": 0.0845,
        "p95Ms": 2739
      },
      {
        "label": "or-gpt-full",
        "vendor": "OpenAI",
        "masked": false,
        "hash8": "819f1ab8",
        "quality": 0.56,
        "ci": 0.139,
        "costPer1K": 0.1482,
        "p95Ms": 1126
      },
      {
        "label": "or-gemini-flash",
        "vendor": "Google",
        "masked": false,
        "hash8": "41a39732",
        "quality": 0.66,
        "ci": 0.1326,
        "costPer1K": 0.1656,
        "p95Ms": 2293
      },
      {
        "label": "or-inkling-small",
        "vendor": "Thinking Machines",
        "masked": false,
        "hash8": "07c9d6a7",
        "quality": 0.92,
        "ci": 0.076,
        "costPer1K": 0.1906,
        "p95Ms": 4009
      },
      {
        "label": "or-gemini-3.7-flash",
        "vendor": "Google",
        "masked": false,
        "hash8": "ffe46bc9",
        "quality": 1,
        "ci": 0,
        "costPer1K": 0.2929,
        "p95Ms": 3242
      },
      {
        "label": "or-inkling",
        "vendor": "Thinking Machines",
        "masked": false,
        "hash8": "8ad63a4e",
        "quality": 0.94,
        "ci": 0.0665,
        "costPer1K": 0.5657,
        "p95Ms": 2449
      },
      {
        "label": "or-kimi-k3",
        "vendor": "Moonshot",
        "masked": false,
        "hash8": "7b918ab8",
        "quality": 0.96,
        "ci": 0.0549,
        "costPer1K": 1.6482,
        "p95Ms": 2422
      }
    ]
  },
  "rag-answer": {
    "version": 3,
    "measuredAt": "2026-08-20",
    "suiteId": "rag-answer",
    "items": null,
    "gradedCells": 50,
    "points": [
      {
        "label": "or-████████████",
        "vendor": "name withheld",
        "masked": true,
        "hash8": "220a2558",
        "quality": 0.92,
        "ci": 0.076,
        "costPer1K": 0.0059,
        "p95Ms": 4864
      },
      {
        "label": "or-ling-3.0-flash",
        "vendor": "inclusionAI",
        "masked": false,
        "hash8": "e4263e18",
        "quality": 0.96,
        "ci": 0.0549,
        "costPer1K": 0.008,
        "p95Ms": 1660
      },
      {
        "label": "or-deepseek-v4-flash-0731",
        "vendor": "DeepSeek",
        "masked": false,
        "hash8": "1fd419ee",
        "quality": 0.98,
        "ci": 0.0392,
        "costPer1K": 0.0273,
        "p95Ms": 10095
      },
      {
        "label": "or-gemini-flash",
        "vendor": "Google",
        "masked": false,
        "hash8": "41a39732",
        "quality": 0.94,
        "ci": 0.0665,
        "costPer1K": 0.0455,
        "p95Ms": 754
      },
      {
        "label": "or-inkling-small",
        "vendor": "Thinking Machines",
        "masked": false,
        "hash8": "07c9d6a7",
        "quality": 0.98,
        "ci": 0.0392,
        "costPer1K": 0.0961,
        "p95Ms": 1061
      }
    ]
  },
  "rewrite-edit": {
    "version": 3,
    "measuredAt": "2026-08-21",
    "suiteId": "rewrite-edit",
    "items": null,
    "gradedCells": 14,
    "points": [
      {
        "label": "or-nemotron-3.5-lightning",
        "vendor": "NVIDIA",
        "masked": false,
        "hash8": "238db164",
        "quality": 0.7,
        "ci": 0.1872,
        "costPer1K": 2.3255,
        "p95Ms": 12837
      },
      {
        "label": "or-gpt-mini",
        "vendor": "OpenAI",
        "masked": false,
        "hash8": "4e2fc860",
        "quality": 0.8786,
        "ci": 0.0717,
        "costPer1K": 2.451,
        "p95Ms": 2998
      },
      {
        "label": "or-deepseek → or-opus",
        "vendor": "cascade",
        "masked": false,
        "hash8": "57f69a06",
        "quality": 0.8857,
        "ci": 0.0538,
        "costPer1K": 3.9357,
        "p95Ms": 14853
      },
      {
        "label": "or-sonnet",
        "vendor": "Anthropic",
        "masked": false,
        "hash8": "07b4dc72",
        "quality": 0.9214,
        "ci": 0.0622,
        "costPer1K": 4.5744,
        "p95Ms": 5781
      },
      {
        "label": "or-claude-opus-5-fast",
        "vendor": "Anthropic",
        "masked": false,
        "hash8": "5f447610",
        "quality": 0.9571,
        "ci": 0.0339,
        "costPer1K": 31.4779,
        "p95Ms": 7591
      }
    ]
  },
  "summarization": {
    "version": 3,
    "measuredAt": "2026-08-20",
    "suiteId": "summarization",
    "items": null,
    "gradedCells": 14,
    "points": [
      {
        "label": "or-ling-3.0-flash",
        "vendor": "inclusionAI",
        "masked": false,
        "hash8": "e4263e18",
        "quality": 0.8929,
        "ci": 0.0632,
        "costPer1K": 2.1951,
        "p95Ms": 2651
      },
      {
        "label": "or-████████████",
        "vendor": "name withheld",
        "masked": true,
        "hash8": "220a2558",
        "quality": 0.9286,
        "ci": 0.0479,
        "costPer1K": 2.2125,
        "p95Ms": 10006
      },
      {
        "label": "or-gpt-mini",
        "vendor": "OpenAI",
        "masked": false,
        "hash8": "4e2fc860",
        "quality": 0.9071,
        "ci": 0.0598,
        "costPer1K": 2.3604,
        "p95Ms": 4223
      },
      {
        "label": "or-gemini-flash",
        "vendor": "Google",
        "masked": false,
        "hash8": "41a39732",
        "quality": 0.8,
        "ci": 0.0919,
        "costPer1K": 2.3841,
        "p95Ms": 1547
      },
      {
        "label": "or-inkling-small",
        "vendor": "Thinking Machines",
        "masked": false,
        "hash8": "07c9d6a7",
        "quality": 0.9429,
        "ci": 0.0396,
        "costPer1K": 2.915,
        "p95Ms": 13836
      },
      {
        "label": "or-muse-glimmer-30b",
        "vendor": "",
        "masked": false,
        "hash8": "bc1c7102",
        "quality": 0.9714,
        "ci": 0.032,
        "costPer1K": 3.2124,
        "p95Ms": 16547
      },
      {
        "label": "or-gpt-full",
        "vendor": "OpenAI",
        "masked": false,
        "hash8": "819f1ab8",
        "quality": 0.9214,
        "ci": 0.0366,
        "costPer1K": 3.2192,
        "p95Ms": 2593
      },
      {
        "label": "or-glm-5.3",
        "vendor": "Z.ai",
        "masked": false,
        "hash8": "74b939b5",
        "quality": 0.9714,
        "ci": 0.0246,
        "costPer1K": 5.1389,
        "p95Ms": 13541
      },
      {
        "label": "or-kimi-k3",
        "vendor": "Moonshot",
        "masked": false,
        "hash8": "7b918ab8",
        "quality": 0.9786,
        "ci": 0.0223,
        "costPer1K": 10.8385,
        "p95Ms": 51602
      },
      {
        "label": "or-gpt-5.6-terra-pro",
        "vendor": "OpenAI",
        "masked": false,
        "hash8": "649924ca",
        "quality": 0.9714,
        "ci": 0.032,
        "costPer1K": 12.1838,
        "p95Ms": 5823
      },
      {
        "label": "or-gpt-5.5-pro",
        "vendor": "OpenAI",
        "masked": false,
        "hash8": "c4550c6e",
        "quality": 0.9786,
        "ci": 0.0223,
        "costPer1K": 42.7365,
        "p95Ms": 31485
      }
    ]
  }
};

/** Figure 3 — the code-gen band. The headline ratio is DERIVED from the two
 * rows shown, so the prose and the bars can never disagree. */
export const CODE_GEN = {
  measuredAt: "2026-08-21",
  version: 4,
  suiteId: "code-gen-hard-v1",
  items: 30,
  gradedCells: 90,
  rows: CLUSTERS['code-gen']!.points.filter((p) => p.quality >= 0.95),
  /** The bar every drawn row clears, named in the caption. */
  floor: 0.95,
  /** Frontier points omitted for measuring below that floor. Widened from its
   * literal type: it varies with the baseline, and callers compare it. */
  belowFloor: 2 as number,
  maxCost: 6.2568,
  minCost: 0.0231,
  /** 270.9x, rounded for prose. */
  ratio: 271,
  ratioWords: "1/271st the price",
  qualityGapPoints: 2.1,
  qualityRetainedPct: 97.8,
} as const;

/** Figure 5 — the interactive explorer runs on multi-step-reasoning: the one
 * cluster whose evidence resolves its own quality spread. */
export const EXPLORER = {
  cluster: 'multi-step-reasoning',
  frontierVersion: 3,
  measuredAt: "2026-08-20",
  items: 50,
  points: CLUSTERS['multi-step-reasoning']!.points,
} as const;

/** The aggregate counts the page is allowed to say. */
export const EVIDENCE = {
  workloadTypes: 10,
  measuredStrategies: 72,
  routableModels: 22,
  gradedEvaluations: 4936,
  source: BASELINE_META.source,
} as const;
