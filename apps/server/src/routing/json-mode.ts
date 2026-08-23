// JSON mode honored at the edge (2026-08-23). Some models reached through
// OpenRouter ignore response_format and wrap the object in ```json fences
// (seen live: or-opus, 62 tokens, perfectly good JSON inside the fence). A
// caller who asked for json_object expects JSON.parse to work, as it does
// on OpenAI. The fence is removed only when what is inside parses; anything
// else is returned untouched, so nothing is ever invented.
export function unwrapJsonFences(text: string): string {
  const m = /^\s*```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```\s*$/.exec(text);
  if (!m) return text;
  const inner = m[1]!.trim();
  try {
    JSON.parse(inner);
    return inner;
  } catch {
    return text;
  }
}

export function wantsJson(responseFormat: { type: string } | undefined): boolean {
  return responseFormat !== undefined && (responseFormat.type === 'json_object' || responseFormat.type === 'json_schema');
}
