// THE SECOND-OPINION ROW (2026-09-04). Three things here are load-bearing
// and all three are the kind that rot silently in a copy edit:
//
//   · the prompt must send the assistant to READ the site. Drop that and it
//     becomes a trivia question about a months-old company no model has in
//     weights, and the visitor watches an assistant say "I have no
//     information about that" — or invent some.
//   · the ?q= payload must be the SAME text on every destination that takes
//     one, and it must be URL-encoded (a raw prompt with & or # in it would
//     be truncated at the first one).
//   · the links must open away from this tab safely (target/rel), because
//     they leave the site.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AskAi, ASK_PROMPT } from '@/components/landing/ask-ai';

const html = renderToStaticMarkup(<AskAi />);

describe('AskAi', () => {
  it('sends the assistant to READ the site, not to recall it', () => {
    expect(ASK_PROMPT).toContain('withpotion.com');
    expect(ASK_PROMPT.toLowerCase()).toContain('read');
    // The failure mode this replaced: a pure knowledge question.
    expect(ASK_PROMPT.toLowerCase()).not.toContain('what do you know about');
  });

  it('invites the skepticism the rest of the page invites', () => {
    expect(ASK_PROMPT.toLowerCase()).toContain('skeptic');
  });

  it('carries the identical, URL-encoded question to every destination that takes one', () => {
    const encoded = encodeURIComponent(ASK_PROMPT);
    expect(html).toContain(`https://chatgpt.com/?q=${encoded}`);
    expect(html).toContain(`https://claude.ai/new?q=${encoded}`);
    // Encoding is not decorative: a space or & reaching the href raw would
    // truncate the question at the first one.
    expect(encoded).not.toContain(' ');
  });

  it('does NOT put ?q= on Gemini, which ignores it — the clipboard is that path', () => {
    expect(html).toContain('https://gemini.google.com/app"');
    expect(html).not.toContain('gemini.google.com/app?q=');
    expect(html).toContain('clipboard');
  });

  it('every assistant link opens in a new tab, safely, and says so', () => {
    const links = html.match(/<a [^>]*href="https:\/\/[^"]*"[^>]*>/g) ?? [];
    expect(links.length).toBe(3);
    for (const a of links) {
      expect(a).toContain('target="_blank"');
      expect(a).toContain('rel="noopener noreferrer"');
    }
    expect(html).toContain('(opens in a new tab)');
  });

  it('names all three assistants', () => {
    for (const name of ['ChatGPT', 'Claude', 'Gemini']) expect(html).toContain(name);
  });
});
