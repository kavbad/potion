'use client';

import { useState } from 'react';

/** Monospace snippet block with a copy button. */
export function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // clipboard API unavailable (non-secure context) — select fallback
      const el = document.createElement('textarea');
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      el.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="flex items-center justify-between border-b border-line bg-paper px-4 py-2">
        <span className="text-xs font-medium text-soft">{label}</span>
        <button
          onClick={copy}
          className="rounded border border-line bg-panel px-2 py-0.5 text-xs text-soft hover:text-ink"
        >
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto bg-panel px-4 py-3 font-mono text-xs leading-relaxed text-ink">
        {text}
      </pre>
    </div>
  );
}
