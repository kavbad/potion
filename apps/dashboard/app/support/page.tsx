'use client';
// P2-9: the support channel. A message lands in the founder's inbox with the
// org attached; the reply comes to the sender's sign-in email. A failed
// delivery says so and names the direct address — never a silent drop.
import { useState } from 'react';

export default function SupportPage() {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch('/api/support', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: message.trim(), page: document.referrer || undefined }),
    }).catch(() => null);
    setBusy(false);
    if (res?.ok) {
      setDone(true);
      setMessage('');
    } else {
      const body = (await res?.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(body?.error?.message ?? 'Could not send — email kavon@mutiny.ai directly.');
    }
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-[2rem] font-medium leading-[1.12] tracking-[-0.02em] text-ink">Support</h1>
      <p className="mb-8 mt-2 text-sm leading-relaxed text-soft">
        Anything broken, confusing, or missing — write it here and it goes straight to the founder
        with your org attached. Replies go to your sign-in email. Prefer email?{' '}
        <a href="mailto:kavon@mutiny.ai" className="text-accent underline">kavon@mutiny.ai</a> works too.
      </p>
      {done ? (
        <div className="border border-[#d9d5cb] bg-[#fbfaf7] px-5 py-4 text-sm text-ink">
          Sent. You&rsquo;ll hear back at your sign-in email.
          <button type="button" onClick={() => setDone(false)} className="ml-3 text-accent underline">
            Send another
          </button>
        </div>
      ) : (
        <form onSubmit={send} className="border border-[#d9d5cb] bg-[#fbfaf7] px-5 py-4">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            required
            maxLength={4000}
            rows={6}
            placeholder="What happened, what you expected, and — if it's about a request — the receipt's model and time help a lot."
            className="w-full resize-y border border-[#d9d5cb] bg-white px-3 py-2 text-[13.5px] leading-relaxed text-ink outline-none focus:border-accent"
          />
          <div className="mt-3 flex items-center justify-between">
            <span className="font-mono text-[11px] text-faint">{message.length}/4000</span>
            <button
              type="submit"
              disabled={busy || message.trim().length === 0}
              className="bg-ink px-4 py-2 text-[12px] font-medium text-[#f4f2ec] hover:opacity-90 disabled:opacity-40"
            >
              {busy ? 'Sending…' : 'Send'}
            </button>
          </div>
          {error && <p className="mt-2 text-[12px] text-warn">{error}</p>}
        </form>
      )}
    </div>
  );
}
