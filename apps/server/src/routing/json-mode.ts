// JSON mode honored at the edge (2026-08-23). Some models reached through
// OpenRouter ignore response_format and wrap the object in ```json fences
// (seen live: or-opus, 62 tokens, perfectly good JSON inside the fence). A
// caller who asked for json_object expects JSON.parse to work, as it does
// on OpenAI. The fence is removed only when what is inside parses; anything
// else is returned untouched, so nothing is ever invented.
export function unwrapJsonFences(text: string): string {
  const parses = (t: string): boolean => {
    try { JSON.parse(t); return true; } catch { return false; }
  };
  const trimmed = text.trim();
  if (parses(trimmed)) return trimmed;
  // The first fenced block whose inside parses wins: in JSON mode the caller
  // asked for the object, and a model's note before or after it (seen live:
  // "```json {…} ``` Note: the population…") is not part of the contract.
  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    const inner = m[1]!.trim();
    if (parses(inner)) return inner;
  }
  return text;
}

export function wantsJson(responseFormat: { type: string } | undefined): boolean {
  return responseFormat !== undefined && (responseFormat.type === 'json_object' || responseFormat.type === 'json_schema');
}
