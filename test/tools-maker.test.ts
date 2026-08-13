import { expect, test, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Api, RfqDto } from "../src/client.ts";
import type { Deps } from "../src/tools/deps.ts";
import { registerMakerTools } from "../src/tools/maker.ts";

const rfq: RfqDto = { rfqId: "r1", taker: "tk", direction: "SELL", qty: "0.01", base: "cBTC", quote: "USDC", deadline: "2026-07-26T01:00:00Z", invitedMakers: ["agent"], feeBps: 10, open: true };

type Handler = (a: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;

/** Build the maker tools against stubbed deps and return { handlers, signer }
 * so a test can assert on what got signed. */
function harness(over: { api?: Partial<Api>; stream?: Partial<Deps["stream"]>; cfg?: Partial<Deps["cfg"]> } = {}): { handlers: Map<string, Handler>; signer: { run: ReturnType<typeof vi.fn> } } {
  const handlers = new Map<string, Handler>();
  const server = { registerTool: (n: string, _c: unknown, h: Handler) => handlers.set(n, h) } as unknown as McpServer;
  const signer = { run: vi.fn() };
  const deps = {
    api: over.api ?? {}, log: () => {}, signer, identity: { hint: "agent" }, stream: over.stream ?? {},
    cfg: { maxNotional: 100000, instrumentWhitelist: [], maxPriceDeviationBps: 500, settleTimeoutMs: 1000, pollMs: 10, ...over.cfg },
  } as unknown as Deps;
  registerMakerTools(server, deps);
  return { handlers, signer };
}

test("wait_for_rfq returns the next queued RFQ", async () => {
  const { handlers } = harness({ stream: { next: vi.fn(async () => rfq) } });
  const res = await handlers.get("wait_for_rfq")!({ timeoutSeconds: 1 });
  expect(res.content[0].text).toContain("r1");
});

test("wait_for_rfq reports no RFQ on timeout", async () => {
  const { handlers } = harness({ stream: { next: vi.fn(async () => null) } });
  const res = await handlers.get("wait_for_rfq")!({ timeoutSeconds: 1 });
  expect(res.content[0].text).toMatch(/no rfq/i);
});

test("submit_quote rail-checks, posts the quote and signs the returned pair", async () => {
  const actions = [{ id: "a1", purpose: "propose-dvp", description: "swap", hash: "h1" }];
  const post = vi.fn(async () => ({ quoteId: "q1", rfqId: "r1", price: "50000", status: "pending", actions }));
  const api = { get: vi.fn(async () => ({ price: "50000" })), post };
  const { handlers, signer } = harness({ api: api as Partial<Api>, stream: { get: () => rfq } });
  const res = await handlers.get("submit_quote")!({ rfqId: "r1", price: "50000" });
  expect(res.content[0].text).toContain("q1");
  expect(post).toHaveBeenCalledWith("/maker/quotes", { rfqId: "r1", price: "50000" });
  expect(signer.run).toHaveBeenCalledWith(actions);
});

test("submit_quote refuses an unknown rfqId", async () => {
  const api = { get: vi.fn(async () => []), post: vi.fn() };
  const { handlers } = harness({ api: api as Partial<Api>, stream: { get: () => undefined } });
  const res = await handlers.get("submit_quote")!({ rfqId: "nope", price: "50000" });
  expect(res.isError).toBe(true);
});
