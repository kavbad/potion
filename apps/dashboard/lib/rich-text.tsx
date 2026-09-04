// PLAIN TEXT, READ PLAINLY (2026-09-04) — workers write markdown, and the
// run page was printing it raw: "**What I need to know:**" with the stars,
// the operator's verdict "looks bad, is wonky".
//
// A deliberately TINY renderer: bold, inline code, bullet and numbered
// lists, paragraphs. React nodes only — never dangerouslySetInnerHTML — so
// worker output (untrusted by doctrine) cannot become markup. Anything not
// understood renders as the literal text it is.
import type { ReactNode } from 'react';

/** **bold** and `code` inside one line. */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) {
      out.push(
        <strong key={`${keyPrefix}-b${i}`} className="font-semibold text-ink">
          {tok.slice(2, -2)}
        </strong>,
      );
    } else {
      out.push(
        <code key={`${keyPrefix}-c${i}`} className="rounded-sm bg-[#f1efe8] px-1 py-px font-mono text-[0.92em]">
          {tok.slice(1, -1)}
        </code>,
      );
    }
    last = m.index + tok.length;
    i += 1;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const BULLET = /^\s*[-*·]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,2})[.)]\s+(.*)$/;

/** Block-level render: paragraphs, bullet lists, numbered lists. */
export function RichText({ text, className }: { text: string; className?: string }): ReactNode {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length === 0) return;
    const body = para.join(' ');
    blocks.push(
      <p key={`p${blocks.length}`} className="[&:not(:first-child)]:mt-2">
        {inline(body, `p${blocks.length}`)}
      </p>,
    );
    para = [];
  };
  const flushList = () => {
    if (list === null) return;
    const { ordered, items } = list;
    blocks.push(
      ordered ? (
        <ol key={`l${blocks.length}`} className="mt-2 space-y-1 pl-5 [counter-reset:item]">
          {items.map((t, i) => (
            <li key={i} className="list-decimal">
              {inline(t, `l${blocks.length}-${i}`)}
            </li>
          ))}
        </ol>
      ) : (
        <ul key={`l${blocks.length}`} className="mt-2 space-y-1 pl-5">
          {items.map((t, i) => (
            <li key={i} className="list-disc">
              {inline(t, `l${blocks.length}-${i}`)}
            </li>
          ))}
        </ul>
      ),
    );
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === '') {
      flushPara();
      flushList();
      continue;
    }
    const b = BULLET.exec(line);
    const n = NUMBERED.exec(line);
    if (b !== null || n !== null) {
      flushPara();
      const ordered = n !== null;
      const item = (n !== null ? n[2] : b![1]) ?? '';
      if (list === null || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(item);
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return <div className={className}>{blocks}</div>;
}

/** The distinct things a worker is asking for, one per line — what the ask
 * card turns into a checklist so nothing is missed in a wall of prose. */
export function askItems(question: string): string[] {
  const items: string[] = [];
  for (const raw of question.replace(/\r\n/g, '\n').split('\n')) {
    const n = NUMBERED.exec(raw);
    const b = BULLET.exec(raw);
    const t = (n !== null ? n[2] : b !== null ? b[1] : '')?.trim() ?? '';
    if (t.length > 2) items.push(t.replace(/\*\*/g, ''));
  }
  if (items.length > 0) return items.slice(0, 8);
  // No list markers — but a worker asking for several things in prose is
  // still asking for several things (the live GTM ask was one paragraph
  // holding three questions). Each sentence that ENDS in a question mark is
  // one of them; a single question stays a paragraph, not a list of one.
  const sentences = question
    .replace(/\s+/g, ' ')
    .split(/(?<=\?)\s+/)
    .map((t) => t.trim())
    .filter((t) => t.endsWith('?') && t.length > 12)
    .map((t) => t.replace(/\*\*/g, ''));
  return sentences.length > 1 ? sentences.slice(0, 8) : [];
}

/** Short, mutually exclusive choices a question offers, if any — rendered as
 * buttons that fill the reply. Conservative by design: only yes/no and
 * explicit "A or B" phrasings, never a guess at free-form answers. */
export function quickReplies(question: string): string[] {
  const q = question.toLowerCase();
  if (/\b(yes\s*\/\s*no|should i|shall i|do you want|would you like|confirm)\b/.test(q) && askItems(question).length === 0) {
    return ['Yes, go ahead', 'No — stop here'];
  }
  return [];
}
