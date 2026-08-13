import type { AgentConfig } from "../config.ts";
import { HttpError, type Api, type ReferencePrice } from "../client.ts";
import type { Identity } from "../identity.ts";
import type { Signer } from "../signer.ts";
import type { RfqStream } from "../stream.ts";

export interface Deps {
  cfg: AgentConfig;
  api: Api;
  identity: Identity;
  signer: Signer;
  stream: RfqStream;
  log: (m: string) => void;
}

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function err(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Turns any thrown error into a structured tool error, surfacing the desk's
 * HTTP status + body when present. */
export function toToolError(e: unknown): ToolResult {
  if (e instanceof HttpError) return err(`desk error ${e.status}: ${e.body}`);
  return err(String(e));
}

export async function refPrice(api: Api, base: string, quote: string): Promise<string | null> {
  const r = await api.get<ReferencePrice>(
    `/maker/reference-price?base=${encodeURIComponent(base)}&quote=${encodeURIComponent(quote)}`,
  );
  return r.price;
}
