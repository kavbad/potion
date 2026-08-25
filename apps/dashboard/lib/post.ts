// POST with unified error extraction. Lived in components/recipe-actions
// until the 2026-08-24 surface review retired that page; the helper is
// generic and now lives with the other fetch utilities.
export async function postOrThrow(url: string, body?: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    ...(body !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });
  if (!res.ok) {
    const parsed = (await res.json().catch(() => null)) as {
      error?: { message?: string } | string;
      message?: string;
    } | null;
    const message =
      typeof parsed?.error === 'object'
        ? parsed.error.message
        : typeof parsed?.error === 'string'
          ? parsed.message
          : undefined;
    throw new Error(message ?? `HTTP ${res.status}`);
  }
}
