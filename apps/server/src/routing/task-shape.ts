// The task-shape vector (flywheel groundwork, 2026-08-24).
//
// A CONTENT-FREE structural fingerprint of a request, stamped on
// request_logs at serve time. Everything here is a count, a flag, a bucket,
// or a hash — never text. The discipline is auditable in one place: this
// file must not copy any string a caller sent, and the test suite asserts
// that a distinctive prompt leaves no trace in the serialized shape.
//
// Why now, before any consumer exists: content is deliberately not retained,
// so a shape not derived at serve time is unrecoverable. This is the join
// key that later lets outcome statistics recur across requests — and, only
// if task shapes prove to recur across tenants, as k-anonymous aggregates.
import { sha256 } from '@potion/core';

export interface TaskShape {
  v: 1;
  /** Message counts by role. */
  msgs: number;
  user: number;
  assistant: number;
  system: number;
  tool: number;
  /** Total prompt characters (all message content) — a size, not a text. */
  charsIn: number;
  /** Characters of the last user message. */
  charsLastUser: number;
  /** Tool definitions carried. */
  toolsN: number;
  /** Content-free join key over the tool NAMES: first 12 hex of a sha256
   * over the sorted list. Recurring toolsets collide on purpose. */
  toolSig: string | null;
  jsonMode: boolean;
  stream: boolean;
  imagesN: number;
  audioN: number;
  maxTokens: number | null;
  hasTemperature: boolean;
}

interface LooseMessage {
  role?: unknown;
  content?: unknown;
}
interface LooseBody {
  messages?: unknown;
  tools?: unknown;
  response_format?: unknown;
  stream?: unknown;
  max_tokens?: unknown;
  temperature?: unknown;
}

function contentChars(content: unknown): { chars: number; images: number; audio: number } {
  if (typeof content === 'string') return { chars: content.length, images: 0, audio: 0 };
  if (!Array.isArray(content)) return { chars: 0, images: 0, audio: 0 };
  let chars = 0;
  let images = 0;
  let audio = 0;
  for (const part of content as Array<Record<string, unknown>>) {
    if (part && typeof part === 'object') {
      if (part.type === 'image_url') images += 1;
      else if (part.type === 'input_audio') audio += 1;
      else if (typeof part.text === 'string') chars += part.text.length;
    }
  }
  return { chars, images, audio };
}

export function taskShapeOf(body: unknown): TaskShape {
  const b = (body ?? {}) as LooseBody;
  const messages = Array.isArray(b.messages) ? (b.messages as LooseMessage[]) : [];
  const roles = { user: 0, assistant: 0, system: 0, tool: 0 };
  let charsIn = 0;
  let charsLastUser = 0;
  let imagesN = 0;
  let audioN = 0;
  for (const m of messages) {
    const role = typeof m.role === 'string' ? m.role : '';
    if (role === 'user') roles.user += 1;
    else if (role === 'assistant') roles.assistant += 1;
    else if (role === 'system') roles.system += 1;
    else if (role === 'tool') roles.tool += 1;
    const c = contentChars(m.content);
    charsIn += c.chars;
    imagesN += c.images;
    audioN += c.audio;
    if (role === 'user') charsLastUser = c.chars;
  }
  const tools = Array.isArray(b.tools) ? (b.tools as Array<Record<string, unknown>>) : [];
  const toolNames = tools
    .map((t) => {
      const fn = t.function as Record<string, unknown> | undefined;
      return typeof fn?.name === 'string' ? fn.name : '';
    })
    .filter(Boolean)
    .sort();
  const rf = b.response_format as Record<string, unknown> | undefined;
  return {
    v: 1,
    msgs: messages.length,
    ...roles,
    charsIn,
    charsLastUser,
    toolsN: tools.length,
    toolSig: toolNames.length > 0 ? sha256(toolNames.join('|')).slice(0, 12) : null,
    jsonMode: typeof rf?.type === 'string' && String(rf.type).startsWith('json'),
    stream: b.stream === true,
    imagesN,
    audioN,
    maxTokens: typeof b.max_tokens === 'number' ? b.max_tokens : null,
    hasTemperature: typeof b.temperature === 'number',
  };
}
