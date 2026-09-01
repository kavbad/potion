// THE NARRATOR (2026-09-01) — the work feed speaks human.
//
// Born from the operator's verdict on the raw feed: "hard to follow, looks
// incomplete and incoherent, no payoff." The durable record is for
// machines; the feed is a TRANSLATION. Same law describeAction brought to
// the pore: a step that knows what it means renders itself for the person
// watching — never a JSON dump, never an empty labeled row.
//
// Pure over DTO-shaped inputs so it runs server-side (building the step
// DTO) and is testable without a database.

export interface NarratedStep {
  /** The one-line human header ('read withpotion.com — "Potion — your…"'). */
  title: string;
  /** Optional quieter body (real output worth showing, cleaned). */
  detail?: string;
  /** 'code' renders detail in monospace; 'text' in prose. */
  detailKind?: 'code' | 'text';
  /** True for steps that carry no human information on their own (a
   * tool-calling model step with no text) — the feed hides them; the
   * ACTION row that follows carries the story. */
  hidden?: boolean;
}

interface StepLike {
  kind: 'model' | 'tool' | 'check-in';
  responseText?: string;
  toolCalls?: unknown[];
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  checkInTrigger?: string;
  checkInQuestion?: string;
}

const TRUNCATE = 360;

/** Cut at a word boundary, never mid-word; say that more exists. */
export function clip(text: string, max = TRUNCATE): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > max * 0.6 ? lastSpace : max)} … (the full record holds the rest)`;
}

function asObj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown, max = 200): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function hostOf(url: string): string {
  try {
    return new URL(url).host + (new URL(url).pathname !== '/' ? new URL(url).pathname : '');
  } catch {
    return url.slice(0, 80);
  }
}

/** Per-tool narration. Unknown tools fall back to a labeled, clipped,
 * honest summary — never raw JSON as the headline. */
function narrateTool(name: string, input: unknown, output: unknown): NarratedStep {
  const inp = asObj(input);
  const out = asObj(output);
  const err = str(out.error, 300);
  if (err !== '') {
    return { title: `${name} hit a problem`, detail: clip(err), detailKind: 'text' };
  }

  switch (name) {
    case 'web_fetch': {
      const url = str(inp.url, 200);
      const text = str(out.text ?? out.content, 4000);
      return {
        title: `read ${hostOf(url)}`,
        ...(text !== '' ? { detail: clip(text, 240), detailKind: 'text' as const } : {}),
      };
    }
    case 'web_search': {
      return { title: `searched the web for “${str(inp.query ?? inp.q, 90)}”` };
    }
    case 'browser_open': {
      const url = str(inp.url, 200);
      const title = str(out.title, 120);
      return { title: `opened ${hostOf(url)}${title !== '' ? ` — “${title}”` : ''} in the browser` };
    }
    case 'browser_read': {
      const title = str(out.title, 120);
      return { title: `re-read the page${title !== '' ? ` — “${title}”` : ''}` };
    }
    case 'browser_act': {
      const kind = str(inp.kind, 20) || 'acted';
      const landed = str(out.url, 200);
      return { title: `${kind === 'click' ? 'clicked' : kind === 'type' ? 'typed into' : kind} the page${landed !== '' ? ` — landed on ${hostOf(landed)}` : ''}` };
    }
    case 'run_python':
    case 'run_shell': {
      const stdout = str(out.stdout, 4000).trim();
      const stderr = str(out.stderr, 1000).trim();
      const wrote = Array.isArray(out.filesWritten) ? (out.filesWritten as unknown[]).length : 0;
      const label = name === 'run_python' ? 'ran Python in the sandbox' : 'ran a shell command in the sandbox';
      const suffix = wrote > 0 ? ` — wrote ${wrote} file(s)` : '';
      const body = stdout !== '' ? stdout : stderr;
      return {
        title: `${label}${suffix}`,
        ...(body !== '' ? { detail: clip(body, 420), detailKind: 'code' as const } : {}),
      };
    }
    case 'update_plan': {
      const items = Array.isArray(out.items) ? out.items : Array.isArray(asObj(inp).items) ? (asObj(inp).items as unknown[]) : [];
      const lines = items
        .map((it) => {
          const o = asObj(it);
          const mark = o.status === 'done' ? '✓' : o.status === 'active' ? '▸' : '·';
          return `${mark} ${str(o.step, 90)}`;
        })
        .filter((l) => l.length > 2);
      return {
        title: 'updated its task ledger',
        ...(lines.length > 0 ? { detail: lines.join('\n'), detailKind: 'code' as const } : {}),
      };
    }
    case 'remember': {
      const writes = asObj(out._memoryWrites);
      const reflections = Array.isArray(writes['beat:reflections']) ? (writes['beat:reflections'] as unknown[]).length : 0;
      const newKeys = typeof out.newKeys === 'number' ? out.newKeys : 0;
      return { title: `updated its working memory${newKeys > 0 ? ` — ${newKeys} new fact(s)` : reflections > 0 ? ` — ${reflections} reflection(s)` : ''}` };
    }
    case 'repo_fetch': {
      return { title: `fetched the repository ${str(inp.repo, 120)}` };
    }
    case 'github_pr': {
      return { title: `opened a pull request on ${str(inp.repo, 120)} — “${str(inp.title, 90)}”` };
    }
    case 'fan_out': {
      return { title: 'delegated to helpers' };
    }
    default: {
      // Connector tools are namespaced 'connector.tool' — say who did what.
      const dot = name.indexOf('.');
      const who = dot > 0 ? `${name.slice(0, dot)} · ${name.slice(dot + 1)}` : name;
      const keys = Object.keys(out).slice(0, 4).join(', ');
      return { title: `used ${who}`, ...(keys !== '' ? { detail: clip(`returned: ${keys}`, 160), detailKind: 'text' as const } : {}) };
    }
  }
}

export function narrateStep(step: StepLike): NarratedStep {
  if (step.kind === 'tool') {
    return narrateTool(step.toolName ?? 'a tool', step.toolInput, step.toolOutput);
  }
  if (step.kind === 'check-in') {
    const q = step.checkInQuestion ?? '';
    return {
      title: step.checkInTrigger === 'worker-question' ? 'asked you a question' : 'asked your permission',
      detail: clip(q, 500),
      detailKind: 'text',
    };
  }
  // model step
  const text = (step.responseText ?? '').trim();
  const calls = step.toolCalls ?? [];
  if (text === '' && calls.length > 0) {
    // A tool-calling step with no prose carries no human information of
    // its own — the ACTION row that follows tells the story.
    return { title: '', hidden: true };
  }
  if (text === '') return { title: '', hidden: true };
  return { title: 'thought', detail: clip(text, 500), detailKind: 'text' };
}
