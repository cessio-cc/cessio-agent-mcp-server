import { expect, test, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Api } from "../src/client.ts";
import type { Deps } from "../src/tools/deps.ts";
import { registerInfoTools } from "../src/tools/info.ts";

type Handler = (a: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;

// Minimal harness: capture the handlers registerInfoTools installs.
function harness(api: Partial<Api>): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const server = { registerTool: (name: string, _cfg: unknown, handler: Handler) => handlers.set(name, handler) } as unknown as McpServer;
  const deps = { api, cfg: {}, log: () => {} } as unknown as Deps;
  registerInfoTools(server, deps);
  return handlers;
}

test("get_balances returns holdings from /wallet/holdings", async () => {
  const api = { get: vi.fn(async () => ({ party: "p", holdings: [{ symbol: "USDC", displaySymbol: "USDC", amount: "100" }] })) };
  const h = harness(api as Partial<Api>);
  const res = await h.get("get_balances")!({});
  expect(res.content[0].text).toContain("USDC");
});

test("get_reference_price wraps /maker/reference-price", async () => {
  const api = { get: vi.fn(async () => ({ price: "50000" })) };
  const h = harness(api as Partial<Api>);
  const res = await h.get("get_reference_price")!({ base: "cBTC", quote: "USDC" });
  expect(res.content[0].text).toContain("50000");
  expect((api.get as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("base=cBTC");
});
