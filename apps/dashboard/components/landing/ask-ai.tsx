'use client';

// ASK SOMEONE ELSE (2026-09-04, operator request) — three links that open
// ChatGPT, Claude or Gemini with a question about Potion already written.
//
// THE PROMPT IS A RESEARCH TASK, NOT A TRIVIA QUESTION, and that is the
// whole design. "What do you know about Potion?" is the obvious version and
// the broken one: Potion is months old, no model has it in weights, and the
// answer is either "I have no information about that" or something invented.
// Sending a visitor to watch an assistant fail to recognise us is worse than
// having no button at all. So the prompt tells the assistant to READ
// withpotion.com — all three browse — and then invites it to be skeptical,
// which is the same posture the rest of this page takes. A page whose proof
// section is called "How you know we are not making this up" can afford to
// hand the visitor a skeptic and mean it.
//
// WHAT EACH DESTINATION ACTUALLY DOES WITH ?q= (checked in a browser,
// 2026-09-04 — not assumed from documentation):
//   · chatgpt.com/?q=      fills AND sends, even signed out. Best case.
//   · claude.ai/new?q=     needs a sign-in first, and carries the question
//                          through it (returnTo) to arrive prefilled.
//   · gemini.google.com    IGNORES ?q= — the composer opens empty. Google
//                          publishes no prefill parameter.
// One in three drops the question on the floor, so the click ALSO copies it
// to the clipboard and the caption says so. That is the difference between
// a feature that works everywhere and one that quietly works two-thirds of
// the time; if Google ever honours the parameter, this improves on its own.
import { useState } from 'react';

/** The question, in the visitor's voice — a task, not a quiz. */
export const ASK_PROMPT =
  'Read withpotion.com and tell me what Potion does. Then be skeptical: ' +
  'for a team spending real money on LLM APIs, is a measured inference compiler worth it, ' +
  'and what would you check before believing their savings numbers?';

interface Assistant {
  id: string;
  name: string;
  /** Built from ASK_PROMPT at module load — one encoding, three uses. */
  href: string;
  /** Said out loud under the button, because guessing is the failure mode. */
  note: string;
}

const ASSISTANTS: Assistant[] = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    href: `https://chatgpt.com/?q=${encodeURIComponent(ASK_PROMPT)}`,
    note: 'asks straight away',
  },
  {
    id: 'claude',
    name: 'Claude',
    href: `https://claude.ai/new?q=${encodeURIComponent(ASK_PROMPT)}`,
    note: 'arrives written out',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    href: 'https://gemini.google.com/app',
    note: 'paste it in',
  },
];

export function AskAi() {
  const [copied, setCopied] = useState(false);

  // Fired from the click itself, never awaited before the navigation: the
  // <a> does the opening, so a slow or refused clipboard cannot swallow it.
  const copy = () => {
    void navigator.clipboard
      ?.writeText(ASK_PROMPT)
      .then(() => setCopied(true))
      .catch(() => undefined);
  };

  // The two grey notes below are text-SOFT, not the text-faint every other
  // small label on this page uses: faint measures 2.25:1 on paper, which is
  // fine for a section eyebrow nobody needs to read and not fine for a
  // sentence that tells you what the button is about to do. The eyebrow
  // stays faint, with the rest of the page.
  return (
    <section
      id="second-opinion"
      className="border-t border-[#d9d5cb] bg-[#f4f2ec]"
      data-testid="ask-ai"
    >
      <div className="mx-auto max-w-6xl px-6 py-20 sm:py-24">
        <div className="mx-auto max-w-2xl text-center">
          <div className="font-mono text-[12px] uppercase tracking-[0.14em] text-faint">
            Second opinion
          </div>
          <h2 className="mt-5 text-[1.75rem] font-medium leading-[1.14] tracking-[-0.02em] text-ink sm:text-[2.15rem]">
            Have an assistant read this site and argue with it.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-base leading-relaxed text-soft">
            One click opens a chat with the question already written: what Potion does, and what you
            should check before believing any of it.
          </p>
        </div>

        <div className="mx-auto mt-10 grid max-w-2xl gap-3 sm:grid-cols-3">
          {ASSISTANTS.map((a) => (
            <a
              key={a.id}
              href={a.href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={copy}
              data-testid={`ask-${a.id}`}
              className="group flex flex-col items-center gap-1 border border-[#d9d5cb] bg-[#fbfaf7] px-5 py-5 transition-colors hover:border-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
            >
              <span className="flex items-center gap-1.5 text-[15px] font-medium text-ink">
                {a.name}
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-faint transition-colors group-hover:text-accent" aria-hidden>
                  <path
                    d="M8 16L16 8M16 8H10M16 8v6"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    fill="none"
                  />
                </svg>
                <span className="sr-only">(opens in a new tab)</span>
              </span>
              <span className="font-mono text-[12px] leading-relaxed text-soft">{a.note}</span>
            </a>
          ))}
        </div>

        <p
          className="mx-auto mt-5 max-w-xl text-center font-mono text-[12px] leading-relaxed text-soft"
          aria-live="polite"
        >
          {copied
            ? 'Question copied to your clipboard — paste it if the chat opens empty.'
            : 'The question is copied to your clipboard too, since Gemini will not take it from a link.'}
        </p>
      </div>
    </section>
  );
}
