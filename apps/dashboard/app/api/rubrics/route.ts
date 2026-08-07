// Rubric list (G1.5): GET /api/rubrics — org-scoped, every row pairs the
// rubric text with its status + calibration evidence. Proxied with the
// caller's session cookie.
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function GET() {
  return proxyJson('/api/rubrics', { method: 'GET' });
}
