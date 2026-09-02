'use client';
// ONE ATTACH STATE (2026-09-02) — found by walking the front door as a
// stranger: the harness page has TWO trial starters (the rail's
// always-visible button and the console's, beside the file picker), and
// they held separate state — attach a file, click the rail's button, and
// the data silently never rode. The worker then parks asking for the file
// it was already given (the slot law doing its job on a UI defect).
// Both starters now read the same picked-attachments context; the
// console falls back to local state on pages without the provider.
import { createContext, useContext, useState } from 'react';

export interface TrialAttachment {
  name: string;
  contentBase64: string;
  size: number;
}

interface TrialAttachmentsState {
  attachments: TrialAttachment[];
  setAttachments: (a: TrialAttachment[]) => void;
}

const Ctx = createContext<TrialAttachmentsState | null>(null);

export function TrialAttachmentsProvider({ children }: { children: React.ReactNode }) {
  const [attachments, setAttachments] = useState<TrialAttachment[]>([]);
  return <Ctx.Provider value={{ attachments, setAttachments }}>{children}</Ctx.Provider>;
}

/** null on pages without the provider — callers fall back to local state. */
export function useTrialAttachments(): TrialAttachmentsState | null {
  return useContext(Ctx);
}
