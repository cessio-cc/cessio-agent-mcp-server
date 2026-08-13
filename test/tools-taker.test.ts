import { expect, test, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Api } from "../src/client.ts";
import type { Deps } from "../src/tools/deps.ts";
import { registerTakerTools } from "../src/tools/taker.ts";

type Handler = (a: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function harness(api: Partial<Api>, over: Partial<Deps> = {}): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const server = { registerTool: (n: string, _c: unknown, h: Handler) => handlers.set(n, h) } as unknown as McpServer;
  const deps = {
    api, log: () => {},
    cfg: { maxNotional: 100000, instrumentWhitelist: [], maxPriceDeviationBps: 500, settleTimeoutMs: 1000, pollMs: 10 },
    identity: { hint: "agent" },
    signer: { run: vi.fn() },
    ...over,
  } as unknown as Deps;
  registerTakerTools(server, deps);
  return handlers;
}

test("create_rfq defaults invited makers to desk makers minus self", async () => {
  const post = vi.fn(async () => ({ rfqId: "r1" }));
  const api = { get: vi.fn(async () => ({ feeBps: 10, makers: ["agent", "mk-b"] })), post };
  const h = harness(api as Partial<Api>);
  await h.get("create_rfq")!({ direction: "SELL", base: "cBTC", quote: "USDC", qty: "0.01", durationMinutes: 5 });
  expect(post).toHaveBeenCalledWith("/rfq", expect.objectContaining({ invitedMakers: ["mk-b"], ttlSeconds: 300, qty: "0.01" }));
});

test("accept_quote refuses when a rail is breached and signs nothing", async () => {
  const signer = { run: vi.fn() };
  const rfqMine = [{ rfqId: "r1", base: "cBTC", quote: "USDC", qty: "1", direction: "SELL", quotes: [{ quoteId: "q1", price: "50000", rfqId: "r1" }] }];
  const api = { get: vi.fn(async (p: string) => (p.startsWith("/rfq/mine") ? rfqMine : { price: "50000" })), post: vi.fn() };
  const h = harness(api as Partial<Api>, { signer, cfg: { maxNotional: 100, instrumentWhitelist: [], maxPriceDeviationBps: 500, settleTimeoutMs: 1000, pollMs: 10 } as unknown as Deps["cfg"] });
  const res = await h.get("accept_quote")!({ quoteId: "q1" });
  expect(res.isError).toBe(true);
  expect(res.content[0].text).toMatch(/notional/i);
  expect(signer.run).not.toHaveBeenCalled();
});
