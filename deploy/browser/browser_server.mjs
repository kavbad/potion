// The Potion browser hand (X6) — a CONTROLLED headless-browser service.
// This process is deliberately dumb about policy: it drives pages and
// reports state. The permission engine lives in the runtime (browser acts
// gate at the pore); what THIS layer owns is containment:
//   · SSRF: every request the page makes — navigation, redirect,
//     subresource, fetch — is intercepted and resolved; private, loopback,
//     link-local and metadata addresses are aborted (allow/deny decided
//     per request, cached per host);
//   · caps: bounded concurrent sessions, bounded acts per session, idle
//     TTL sweeps, navigation timeouts, clipped text extraction;
//   · sessions are ephemeral browser contexts — no profile, no persisted
//     cookies beyond the session, closed on TTL or on request.
// Interactables are enumerated with stable in-page refs (p1, p2, …) so an
// act names exactly the element the model was shown.
import { createServer } from 'node:http';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { chromium } from 'playwright';

const PORT = Number(process.env.BROWSER_PORT ?? 8791);
const LIMITS = {
  MAX_SESSIONS: 4,
  SESSION_IDLE_MS: 180_000,
  NAV_TIMEOUT_MS: 20_000,
  ACT_TIMEOUT_MS: 10_000,
  MAX_ACTS_PER_SESSION: 60,
  MAX_TEXT_CHARS: 30_000,
  MAX_INTERACTABLES: 60,
  MAX_BODY_BYTES: 64_000,
};

// ---- SSRF: the resolved-address guard, per request ----
function isPrivateAddress(addr) {
  if (addr.includes(':')) {
    const a = addr.toLowerCase();
    return (
      a === '::1' || a === '::' ||
      a.startsWith('fe80') || a.startsWith('fc') || a.startsWith('fd') ||
      a.startsWith('::ffff:127.') || a.startsWith('::ffff:10.') || a.startsWith('::ffff:192.168.') ||
      a.startsWith('::ffff:169.254.') || /^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(a)
    );
  }
  const p = addr.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  return (
    p[0] === 0 || p[0] === 10 || p[0] === 127 ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 198 && (p[1] === 18 || p[1] === 19)) ||
    p[0] >= 224
  );
}

const hostVerdicts = new Map(); // host -> { ok, at }
async function hostAllowed(host) {
  const cached = hostVerdicts.get(host);
  if (cached !== undefined && Date.now() - cached.at < 300_000) return cached.ok;
  let ok = false;
  if (isIP(host) !== 0) {
    ok = !isPrivateAddress(host);
  } else {
    try {
      const { address } = await dnsLookup(host);
      ok = !isPrivateAddress(address);
    } catch {
      ok = false;
    }
  }
  hostVerdicts.set(host, { ok, at: Date.now() });
  return ok;
}

async function urlAllowed(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username !== '' || u.password !== '') return false;
  return hostAllowed(u.hostname);
}

// ---- sessions ----
let browser = null;
async function getBrowser() {
  if (browser === null) {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  }
  return browser;
}

const sessions = new Map(); // id -> { context, page, acts, lastUsed }
let sessionSeq = 0;

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastUsed > LIMITS.SESSION_IDLE_MS) {
      sessions.delete(id);
      s.context.close().catch(() => {});
    }
  }
}, 30_000).unref();

async function openSession() {
  if (sessions.size >= LIMITS.MAX_SESSIONS) {
    // Evict the stalest rather than refusing — a stuck leg must not brick
    // the service for the next run.
    const oldest = [...sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    if (oldest !== undefined) {
      sessions.delete(oldest[0]);
      oldest[1].context.close().catch(() => {});
    }
  }
  const b = await getBrowser();
  const context = await b.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 PotionWorker/1.0',
    viewport: { width: 1280, height: 900 },
    javaScriptEnabled: true,
  });
  // THE GUARD: every request the page makes goes through here.
  await context.route('**/*', async (route) => {
    const ok = await urlAllowed(route.request().url());
    if (!ok) return route.abort('blockedbyclient');
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(LIMITS.ACT_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(LIMITS.NAV_TIMEOUT_MS);
  const id = `bs-${++sessionSeq}-${Math.random().toString(36).slice(2, 8)}`;
  sessions.set(id, { context, page, acts: 0, lastUsed: Date.now() });
  return id;
}

// ---- page state extraction ----
async function pageState(page) {
  const data = await page.evaluate((maxInteractables) => {
    const clean = (t) => (t ?? '').replace(/\s+/g, ' ').trim();
    let refSeq = 0;
    const interactables = [];
    const selector = 'a[href], button, input, select, textarea, [role="button"], [onclick]';
    for (const el of document.querySelectorAll(selector)) {
      if (interactables.length >= maxInteractables) break;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const ref = `p${++refSeq}`;
      el.setAttribute('data-potion-ref', ref);
      const tag = el.tagName.toLowerCase();
      const label =
        clean(el.getAttribute('aria-label')) ||
        clean(el.labels?.[0]?.textContent) ||
        clean(el.getAttribute('placeholder')) ||
        clean(el.textContent).slice(0, 120) ||
        clean(el.getAttribute('name')) ||
        clean(el.getAttribute('href'))?.slice(0, 120) ||
        tag;
      const entry = { ref, tag, label };
      if (tag === 'input') entry.type = el.getAttribute('type') ?? 'text';
      if (tag === 'input' || tag === 'textarea') entry.value = clean(el.value).slice(0, 120);
      if (tag === 'select') {
        entry.options = [...el.options].slice(0, 20).map((o) => clean(o.textContent).slice(0, 60));
        entry.value = clean(el.value).slice(0, 60);
      }
      interactables.push(entry);
    }
    return {
      title: document.title,
      text: clean(document.body?.innerText ?? ''),
      interactables,
    };
  }, LIMITS.MAX_INTERACTABLES);
  return {
    url: page.url(),
    title: data.title,
    text: data.text.slice(0, LIMITS.MAX_TEXT_CHARS),
    truncated: data.text.length > LIMITS.MAX_TEXT_CHARS,
    interactables: data.interactables,
  };
}

// ---- http plumbing ----
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > LIMITS.MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function getSession(id) {
  const s = sessions.get(id);
  if (s !== undefined) s.lastUsed = Date.now();
  return s;
}

const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url ?? '/', 'http://x');
    const parts = u.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && u.pathname === '/healthz') {
      return send(res, 200, { ok: true, sessions: sessions.size });
    }
    if (req.method === 'POST' && u.pathname === '/session') {
      const id = await openSession();
      return send(res, 200, { sessionId: id });
    }
    if (parts[0] === 'session' && parts.length >= 2) {
      const s = getSession(parts[1]);
      if (req.method === 'DELETE' && parts.length === 2) {
        if (s !== undefined) {
          sessions.delete(parts[1]);
          await s.context.close().catch(() => {});
        }
        return send(res, 200, { ok: true });
      }
      if (s === undefined) return send(res, 404, { error: 'unknown or expired session' });

      if (req.method === 'POST' && parts[2] === 'goto') {
        const body = await readBody(req);
        if (typeof body.url !== 'string' || !(await urlAllowed(body.url))) {
          return send(res, 422, { error: 'url refused: http(s) to public addresses only' });
        }
        try {
          await s.page.goto(body.url, { waitUntil: 'domcontentloaded' });
          await s.page.waitForTimeout(400); // settle: client-side rendering
        } catch (e) {
          return send(res, 422, { error: `navigation failed: ${String(e.message ?? e).slice(0, 160)}` });
        }
        return send(res, 200, await pageState(s.page));
      }
      if (req.method === 'GET' && parts[2] === 'state') {
        return send(res, 200, await pageState(s.page));
      }
      if (req.method === 'POST' && parts[2] === 'act') {
        if (++s.acts > LIMITS.MAX_ACTS_PER_SESSION) {
          return send(res, 429, { error: `act cap reached (${LIMITS.MAX_ACTS_PER_SESSION} per session)` });
        }
        const body = await readBody(req);
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const kind = body.kind;
        if (!/^p\d{1,3}$/.test(ref)) return send(res, 422, { error: 'ref must be a p<N> id from the page state' });
        const el = s.page.locator(`[data-potion-ref="${ref}"]`);
        try {
          if (kind === 'click') {
            await Promise.all([
              s.page.waitForLoadState('domcontentloaded').catch(() => {}),
              el.click({ timeout: LIMITS.ACT_TIMEOUT_MS }),
            ]);
            await s.page.waitForTimeout(500);
          } else if (kind === 'type') {
            if (typeof body.text !== 'string') return send(res, 422, { error: 'type needs text' });
            await el.fill(body.text.slice(0, 4000), { timeout: LIMITS.ACT_TIMEOUT_MS });
          } else if (kind === 'select') {
            if (typeof body.text !== 'string') return send(res, 422, { error: 'select needs text (the option label)' });
            await el.selectOption({ label: body.text }, { timeout: LIMITS.ACT_TIMEOUT_MS });
          } else if (kind === 'press') {
            if (typeof body.text !== 'string') return send(res, 422, { error: "press needs text (a key, e.g. 'Enter')" });
            await el.press(body.text.slice(0, 30), { timeout: LIMITS.ACT_TIMEOUT_MS });
            await s.page.waitForTimeout(500);
          } else {
            return send(res, 422, { error: 'kind must be click|type|select|press' });
          }
        } catch (e) {
          return send(res, 422, { error: `act failed: ${String(e.message ?? e).slice(0, 160)}` });
        }
        return send(res, 200, await pageState(s.page));
      }
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 500, { error: String(e?.message ?? e).slice(0, 200) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[potion-browser] listening on :${PORT}`);
});
