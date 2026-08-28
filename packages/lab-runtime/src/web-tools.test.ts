// The web hands (P1) — SSRF guard units, extraction units, and the two
// tools end-to-end against injected fetch/lookup (no network in tests).
import { describe, expect, it } from 'vitest';
import { buildWebLabTools, checkUrl, htmlToText, isPrivateAddress, parseFeed, WEB_LIMITS } from './web-tools.js';

describe('isPrivateAddress — the blocked ranges', () => {
  it('blocks loopback, RFC1918, link-local/metadata, CGNAT, multicast, v4-mapped', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });
  it('allows public addresses', () => {
    for (const ip of ['93.184.216.34', '172.32.0.1', '100.128.0.1', '2606:2800:220:1::1']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe('checkUrl — scheme, credentials, resolution', () => {
  const publicLookup = async () => ({ address: '93.184.216.34' });
  const privateLookup = async () => ({ address: '10.0.0.5' });
  it('refuses non-http schemes and credentialed URLs', async () => {
    expect((await checkUrl('file:///etc/passwd', {})).ok).toBe(false);
    expect((await checkUrl('ftp://example.com/x', {})).ok).toBe(false);
    expect((await checkUrl('https://user:pass@example.com/', { lookupImpl: publicLookup })).ok).toBe(false);
  });
  it('refuses hosts resolving to private space; allows public', async () => {
    expect((await checkUrl('https://internal.example/', { lookupImpl: privateLookup })).ok).toBe(false);
    expect((await checkUrl('https://example.com/', { lookupImpl: publicLookup })).ok).toBe(true);
  });
  it('refuses literal private IPs without any lookup', async () => {
    expect((await checkUrl('http://169.254.169.254/latest/meta-data/', {})).ok).toBe(false);
  });
});

function fakeResponse(body: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(body, { status: init.status ?? 200, headers: init.headers ?? { 'content-type': 'text/html' } });
}

describe('web_fetch — extraction, redaction, redirect law', () => {
  const publicLookup = async () => ({ address: '93.184.216.34' });
  it('returns title + text; strips script/style; redacts key shapes', async () => {
    const html = '<html><head><title>Pricing &mdash; Northwind</title><style>.x{}</style></head><body><script>evil()</script><h1>Pro: $39/mo</h1><p>Contact sk-or-v1-abcdefabcdefabcdef for perks.</p></body></html>';
    const [fetchTool] = buildWebLabTools({ fetchImpl: async () => fakeResponse(html), lookupImpl: publicLookup });
    const out = (await fetchTool!.run({ url: 'https://northwind.example/pricing' })) as { title: string; text: string };
    expect(out.title).toBe('Pricing — Northwind');
    expect(out.text).toContain('Pro: $39/mo');
    expect(out.text).not.toContain('evil()');
    expect(out.text).not.toContain('sk-or-v1');
    expect(out.text).toContain('[redacted:openrouter-key]');
  });
  it('every redirect hop is re-validated — a hop into private space is refused', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL) => {
      seen.push(String(url));
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/creds' } });
    }) as typeof fetch;
    const [fetchTool] = buildWebLabTools({ fetchImpl, lookupImpl: publicLookup });
    const out = (await fetchTool!.run({ url: 'https://example.com/start' })) as { error?: string };
    expect(out.error).toContain('blocked range');
    expect(seen.length).toBe(1); // the private hop was never fetched
  });
  it('body bytes are capped', async () => {
    const big = '<html><body>' + 'a'.repeat(WEB_LIMITS.MAX_BODY_BYTES * 2) + '</body></html>';
    const [fetchTool] = buildWebLabTools({ fetchImpl: async () => fakeResponse(big), lookupImpl: publicLookup });
    const out = (await fetchTool!.run({ url: 'https://example.com/big' })) as { text: string };
    expect(out.text.length).toBeLessThanOrEqual(WEB_LIMITS.MAX_TEXT_CHARS);
  });
});

describe('web_feed — RSS and Atom', () => {
  const publicLookup = async () => ({ address: '93.184.216.34' });
  const RSS = `<?xml version="1.0"?><rss><channel><title>Changelog</title>
    <item><title>Bulk import shipped</title><link>https://contoso.example/log/42</link><pubDate>Wed, 27 Aug 2026 09:00:00 GMT</pubDate><description><![CDATA[CSV <b>import</b> is live]]></description></item>
    <item><title>Minor fixes</title><link>https://contoso.example/log/41</link></item>
  </channel></rss>`;
  const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Notes</title>
    <entry><title>Series B</title><link href="https://fabrikam.example/notes/7"/><updated>2026-08-12T10:00:00Z</updated><summary>We raised.</summary></entry>
  </feed>`;
  it('parses RSS items with CDATA and entities', () => {
    const { title, items } = parseFeed(RSS);
    expect(title).toBe('Changelog');
    expect(items).toHaveLength(2);
    expect(items[0]!.title).toBe('Bulk import shipped');
    expect(items[0]!.link).toBe('https://contoso.example/log/42');
    expect(items[0]!.summary).toContain('CSV import is live');
  });
  it('parses Atom entries with href links', () => {
    const { items } = parseFeed(ATOM);
    expect(items[0]!.title).toBe('Series B');
    expect(items[0]!.link).toBe('https://fabrikam.example/notes/7');
    expect(items[0]!.published).toBe('2026-08-12T10:00:00Z');
  });
  it('the tool end-to-end returns parsed items', async () => {
    const tools = buildWebLabTools({ fetchImpl: async () => fakeResponse(RSS, { headers: { 'content-type': 'application/rss+xml' } }), lookupImpl: publicLookup });
    const out = (await tools[1]!.run({ url: 'https://contoso.example/feed.xml' })) as { items: unknown[] };
    expect(out.items).toHaveLength(2);
  });
});

describe('htmlToText', () => {
  it('collapses whitespace and decodes numeric entities', () => {
    const { text } = htmlToText('<p>a&#160;&#x2014;&nbsp;b</p>\n\n\n<p>c</p>');
    expect(text).toContain('—');
    expect(text).toContain('c');
  });
});
