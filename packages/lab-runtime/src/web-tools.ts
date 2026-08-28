// The web superpower (P1, "the hands") — the catalog's first LIVE tools.
// In-process, read-only by construction: there is no write verb in this
// file. Two tools: web_fetch (a page, extracted to text) and web_feed (an
// RSS/Atom feed, parsed to items). No OAuth, no vendor, no credentials.
//
// Laws:
//  · SSRF-blocked: http(s) only, no credentials in the URL, every hop of a
//    redirect chain re-validated, and the RESOLVED ADDRESS checked against
//    private/loopback/link-local/metadata ranges — hostname allowlists are
//    theater, address checks are not;
//  · capped: response bytes, extracted characters, redirect hops, timeout;
//  · custody: fetched text is secret-REDACTED before it enters the model's
//    context or a durable step (a public page quoting a key shape must not
//    kill the run — the checkpoint scanner stays the fail-closed backstop);
//  · classification: both tools are READ class (the T8 audit exhibit
//    carries their verdicts) — reads do not fire the before-external-action
//    pore, the same law every MCP connector's reads follow. There is no
//    act verb here to gate.
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { redactSecrets } from '@potion/lab-spec';
import type { LabTool } from './loop.js';

export const WEB_LIMITS = {
  MAX_BODY_BYTES: 2 * 1024 * 1024,
  MAX_TEXT_CHARS: 40_000,
  MAX_FEED_ITEMS: 30,
  MAX_ITEM_CHARS: 600,
  MAX_REDIRECTS: 3,
  TIMEOUT_MS: 10_000,
} as const;

export interface WebToolDeps {
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to dns.promises.lookup. */
  lookupImpl?: (hostname: string) => Promise<{ address: string }>;
  /** Dev-only escape for local walkthroughs against localhost fixtures.
   * NEVER set in production; the builder reads it from an explicit option,
   * not ambient env, so a stray env var cannot open the guard silently. */
  allowPrivate?: boolean;
}

/** Is this literal IP address inside a range the tools must never touch? */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const low = ip.toLowerCase();
    if (low.startsWith('::ffff:')) return isPrivateAddress(low.slice(7)); // v4-mapped → check the v4
    return low === '::' || low === '::1' || low.startsWith('fe80:') || low.startsWith('fc') || low.startsWith('fd');
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true; // unparseable → refuse
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local + cloud metadata
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast + reserved
  );
}

export type UrlVerdict = { ok: true; url: URL } | { ok: false; reason: string };

/** Validate one URL and resolve its address — every redirect hop passes
 * through here again. */
export async function checkUrl(raw: string, deps: WebToolDeps): Promise<UrlVerdict> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `not a valid URL: ${String(raw).slice(0, 120)}` };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: `scheme '${url.protocol}' refused — http(s) only` };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'credentials in URLs are refused' };
  }
  if (deps.allowPrivate === true) return { ok: true, url };
  const host = url.hostname;
  const literal = isIP(host) !== 0 ? host : null;
  if (literal !== null) {
    if (isPrivateAddress(literal)) return { ok: false, reason: `address ${literal} is in a blocked range` };
    return { ok: true, url };
  }
  try {
    const lookupFn = deps.lookupImpl ?? (async (h: string) => dnsLookup(h));
    const { address } = await lookupFn(host);
    if (isPrivateAddress(address)) {
      return { ok: false, reason: `'${host}' resolves to ${address} — blocked range` };
    }
  } catch {
    return { ok: false, reason: `'${host}' did not resolve` };
  }
  return { ok: true, url };
}

/** Fetch with manual redirects (each hop re-validated) + byte cap + timeout. */
async function guardedFetch(
  raw: string,
  deps: WebToolDeps,
): Promise<{ ok: true; body: string; finalUrl: string; contentType: string } | { ok: false; reason: string }> {
  const fetchFn = deps.fetchImpl ?? fetch;
  let current = raw;
  for (let hop = 0; hop <= WEB_LIMITS.MAX_REDIRECTS; hop++) {
    const verdict = await checkUrl(current, deps);
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEB_LIMITS.TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchFn(verdict.url.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': 'PotionLab/1.0 (+https://withpotion.com)', accept: 'text/html,application/xhtml+xml,application/xml,application/rss+xml,application/atom+xml,text/plain' },
      });
    } catch (e) {
      clearTimeout(timer);
      return { ok: false, reason: `fetch failed: ${(e as Error).message.slice(0, 160)}` };
    }
    clearTimeout(timer);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (loc === null) return { ok: false, reason: `redirect ${res.status} without a location` };
      current = new URL(loc, verdict.url).toString();
      continue;
    }
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const reader = res.body?.getReader();
    if (!reader) {
      const text = await res.text();
      return {
        ok: true,
        body: text.slice(0, WEB_LIMITS.MAX_BODY_BYTES),
        finalUrl: verdict.url.toString(),
        contentType: res.headers.get('content-type') ?? '',
      };
    }
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > WEB_LIMITS.MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        chunks.push(value.subarray(0, Math.max(0, WEB_LIMITS.MAX_BODY_BYTES - (received - value.byteLength))));
        break;
      }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
    return { ok: true, body, finalUrl: verdict.url.toString(), contentType: res.headers.get('content-type') ?? '' };
  }
  return { ok: false, reason: `more than ${WEB_LIMITS.MAX_REDIRECTS} redirects` };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', hellip: '…' };
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

/** HTML → readable text: drop script/style/nav chrome, tags → whitespace,
 * entities decoded, whitespace collapsed. Deterministic, dependency-free. */
export function htmlToText(html: string): { title: string | null; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? null;
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:nav|header|footer|aside)[\s\S]*?<\/(?:nav|header|footer|aside)>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(stripped).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title: title !== null ? decodeEntities(title) : null, text: text.slice(0, WEB_LIMITS.MAX_TEXT_CHARS) };
}

interface FeedItem {
  title: string;
  link: string | null;
  published: string | null;
  summary: string | null;
}

function firstTag(block: string, names: string[]): string | null {
  for (const n of names) {
    const m = new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`, 'i').exec(block);
    if (m?.[1] !== undefined) {
      const inner = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
      const text = decodeEntities(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      if (text.length > 0) return text.slice(0, WEB_LIMITS.MAX_ITEM_CHARS);
    }
  }
  return null;
}

function atomLink(block: string): string | null {
  const m = /<link[^>]*href=["']([^"']+)["'][^>]*\/?>(?:<\/link>)?/i.exec(block);
  return m?.[1] !== undefined ? decodeEntities(m[1]) : null;
}

/** RSS 2.0 <item> and Atom <entry>, minimally and deterministically. */
export function parseFeed(xml: string): { title: string | null; items: FeedItem[] } {
  const feedTitle = firstTag(xml.slice(0, 4000), ['title']);
  const blocks: string[] = [];
  const itemRe = /<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null && blocks.length < WEB_LIMITS.MAX_FEED_ITEMS) {
    blocks.push(m[0]);
  }
  const items = blocks.map((b) => ({
    title: firstTag(b, ['title']) ?? '(untitled)',
    link: firstTag(b, ['link']) ?? atomLink(b),
    published: firstTag(b, ['pubDate', 'published', 'updated', 'dc:date']),
    summary: firstTag(b, ['description', 'summary', 'content']),
  }));
  return { title: feedTitle, items };
}

/** Build the two live web tools — read class, non-gating (the catalog's
 * classification law: reads never fire the pore; there is no act verb in
 * this package to gate). */
export function buildWebLabTools(deps: WebToolDeps = {}): LabTool[] {
  return [
    {
      name: 'web_fetch',
      description:
        'Fetch one public web page and return its readable text (title + body, truncated). Read-only. Use for pricing pages, changelogs, articles.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The http(s) URL to fetch.' } },
        required: ['url'],
      },
      external: false,
      run: async (input: unknown) => {
        const url = String((input as { url?: unknown } | null)?.url ?? '');
        const got = await guardedFetch(url, deps);
        if (!got.ok) return { error: got.reason };
        const { title, text } = htmlToText(got.body);
        return { url: got.finalUrl, title, text: redactSecrets(text) };
      },
    },
    {
      name: 'web_feed',
      description:
        'Fetch an RSS or Atom feed and return its items (title, link, published, summary). Read-only. Use for newsletters, blogs, changelogs with feeds.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The http(s) feed URL.' } },
        required: ['url'],
      },
      external: false,
      run: async (input: unknown) => {
        const url = String((input as { url?: unknown } | null)?.url ?? '');
        const got = await guardedFetch(url, deps);
        if (!got.ok) return { error: got.reason };
        const { title, items } = parseFeed(got.body);
        return {
          url: got.finalUrl,
          title,
          items: items.map((i) => ({
            ...i,
            title: redactSecrets(i.title),
            summary: i.summary !== null ? redactSecrets(i.summary) : null,
          })),
        };
      },
    },
  ];
}
