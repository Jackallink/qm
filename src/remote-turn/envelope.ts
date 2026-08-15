import { createHash } from "node:crypto";

const encoder = new TextEncoder();

function frame(...parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function lengthPrefixed(value: string): Uint8Array {
  const bytes = encoder.encode(value);
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, bytes.length);
  return frame(header, bytes);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface RemoteTurnHistoryMessage {
  role: "user" | "assistant";
  text: string;
}

export function computeInputDigest(text: string): string {
  return sha256(encoder.encode(text));
}

export function computeHistoryDigest(history: readonly RemoteTurnHistoryMessage[]): string {
  const frames = history.map((message) => frame(lengthPrefixed(message.role), lengthPrefixed(message.text)));
  const joined = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
  let offset = 0;
  for (const f of frames) {
    joined.set(f, offset);
    offset += f.length;
  }
  return sha256(joined);
}

export interface EnvelopeDigestFields {
  remoteTurnId: string;
  bindingVersion: number;
  conversationKey: string;
  scopeId: string;
  qmSessionId: string;
  coreRunId: string;
  inputDigest: string;
  historyDigest: string;
}

export function computeEnvelopeDigest(fields: EnvelopeDigestFields): string {
  const parts = [
    fields.remoteTurnId,
    String(fields.bindingVersion),
    fields.conversationKey,
    fields.scopeId,
    fields.qmSessionId,
    fields.coreRunId,
    fields.inputDigest,
    fields.historyDigest,
  ];
  const frames = parts.map(lengthPrefixed);
  const joined = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
  let offset = 0;
  for (const f of frames) {
    joined.set(f, offset);
    offset += f.length;
  }
  return sha256(joined);
}
