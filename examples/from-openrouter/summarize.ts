#!/usr/bin/env node
// summarize.ts — read a text file and ask the model for a 3-bullet summary.
//   POTION_API_KEY=... npx tsx summarize.ts input.txt
//   SUMMARY_MODEL=best POTION_API_KEY=... npx tsx summarize.ts input.txt   (see picker note below)
//
// Migrated from OpenRouter to Potion. Old values are left commented so you can roll back.
import { readFile } from "node:fs/promises";
import OpenAI from "openai";

// const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";   // before: OpenRouter
const POTION_BASE_URL = "https://api.withpotion.com/v1";
// const DEFAULT_MODEL = "openai/gpt-4.1";                        // before: pinned provider model
const DEFAULT_MODEL = "potion-auto";

// Tiny user-facing model picker. SUMMARY_MODEL still accepts the old aliases
// (and raw model ids) so callers don't break, but for now every choice maps
// to "potion-auto": the routing rule bound to your Potion key decides the
// model, and the receipt (x-frontier-trace) shows what it chose.
// NOTE FOR THE HUMAN: the picker is effectively a no-op until you decide
// whether to keep it, drop it, or bind different Potion keys/rules per tier.
const MODEL_CHOICES: Record<string, string> = {
  fast: DEFAULT_MODEL, // before: "openai/gpt-4.1-mini"
  default: DEFAULT_MODEL, // before: "openai/gpt-4.1"
  best: DEFAULT_MODEL, // before: "anthropic/claude-sonnet-4"
};

function pickModel(): string {
  const wanted = process.env.SUMMARY_MODEL ?? "default";
  // before: return MODEL_CHOICES[wanted] ?? wanted;   (raw ids passed straight through)
  if (!(wanted in MODEL_CHOICES)) {
    console.error(`note: SUMMARY_MODEL=${wanted} is routed as ${DEFAULT_MODEL} (Potion rule decides the model)`);
  }
  return MODEL_CHOICES[wanted] ?? DEFAULT_MODEL;
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: summarize.ts <file.txt>");
    process.exit(1);
  }
  // const apiKey = process.env.OPENROUTER_API_KEY;   // before: OpenRouter key
  const apiKey = process.env.POTION_API_KEY;
  if (!apiKey) {
    console.error("POTION_API_KEY is not set");
    process.exit(1);
  }

  const text = await readFile(path, "utf8");
  const client = new OpenAI({
    apiKey,
    baseURL: POTION_BASE_URL,
    // OpenRouter attribution headers removed — Potion ignores them.
    // defaultHeaders: {
    //   "HTTP-Referer": "https://example.com/summarize",
    //   "X-Title": "summarize.ts",
    // },
  });

  const model = pickModel();
  const { data: completion, response } = await client.chat.completions
    .create({
      model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "You summarize documents. Reply with exactly three bullet points, one sentence each, nothing else.",
        },
        { role: "user", content: text },
      ],
    })
    .withResponse();

  console.log(`model: ${completion.model}`);
  console.log(completion.choices[0]?.message?.content ?? "(no content)");

  // Potion's receipt: which kind of work, which strategy/rule, and whether the
  // evidence was live. If it is missing, the request did not go through Potion.
  const receipt = response.headers.get("x-frontier-trace");
  if (receipt) {
    console.log(`receipt (x-frontier-trace): ${receipt}`);
  } else {
    console.error("warning: no x-frontier-trace header — this request did not go through Potion");
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
