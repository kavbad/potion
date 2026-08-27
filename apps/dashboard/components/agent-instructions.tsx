'use client';

// "HAND THIS TO YOUR AGENT" (operator, 2026-08-22): time to value for a
// team whose integration is done by Claude Code or another coding agent.
// One instruction block per situation, written FOR the agent — concrete
// steps, what to change, what to keep, how to verify, what never to do.
// The key is never embedded: the block tells the agent where to read it.
import { useState } from 'react';

import { block, SITUATIONS, type Situation } from '@/lib/agent-blocks';

export function AgentInstructions({ baseUrl }: { baseUrl: string }) {
  const [situation, setSituation] = useState<Situation>('openai-sdk');
  const [copied, setCopied] = useState(false);
  const text = block(situation, baseUrl);
  return (
    <div className="border border-[#d9d5cb] bg-[#fbfaf7]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#d9d5cb] px-4 py-2.5">
        <div className="font-mono text-[11.5px] uppercase tracking-[0.13em] text-faint">hand this to your agent · claude code, cursor, codex, anything</div>
        <button
          type="button"
          onClick={() => { void navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1800); }}
          className="bg-ink px-3 py-1 font-mono text-[12px] text-[#f4f2ec] hover:opacity-90"
        >
          {copied ? 'copied' : 'copy instructions'}
        </button>
      </div>
      <div className="flex flex-wrap gap-px border-b border-[#d9d5cb] bg-[#d9d5cb]">
        {SITUATIONS.map((s) => (
          <button key={s.id} type="button" onClick={() => setSituation(s.id)} className={`px-3 py-1.5 font-mono text-[12px] ${situation === s.id ? 'bg-ink text-[#f4f2ec]' : 'bg-[#fbfaf7] text-soft hover:text-ink'}`}>
            {s.label}
          </button>
        ))}
      </div>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-[12px] leading-relaxed text-soft">{text}</pre>
      <p className="border-t border-[#d9d5cb] px-4 py-2 font-mono text-[11.5px] text-faint">Paste it into your agent with your key already in the environment. The block never contains the key.</p>
    </div>
  );
}
