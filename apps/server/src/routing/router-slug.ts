// R1 (Router direction, 2026-08-27): the router's NAME — `potion/<slug>` —
// derived deterministically from the org name. The alias is only ever
// resolved against the caller's own org (never a cross-org lookup), so
// collisions between orgs are structurally meaningless.
export function routerSlug(orgName: string): string {
  const slug = orgName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug.length > 0 ? slug : 'org';
}

export function routerModelName(orgName: string): string {
  return `potion/${routerSlug(orgName)}`;
}
