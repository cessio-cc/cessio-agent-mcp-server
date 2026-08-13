import { expect, test, vi } from "vitest";
import { buildServer } from "../src/server.ts";
import { registerInfoTools } from "../src/tools/info.ts";
import { registerMakerTools } from "../src/tools/maker.ts";
import { registerTakerTools } from "../src/tools/taker.ts";
import type { Deps } from "../src/tools/deps.ts";

const deps = {
  api: { get: vi.fn(), post: vi.fn(), del: vi.fn(), streamOptions: () => ({ url: "ws://x", headers: {} }) },
  cfg: { maxNotional: null, instrumentWhitelist: [], maxPriceDeviationBps: 500, settleTimeoutMs: 1000, pollMs: 10 },
  identity: { hint: "agent" }, signer: { run: vi.fn() }, stream: { next: vi.fn(), get: vi.fn(), close: vi.fn() }, log: () => {},
} as unknown as Deps;

test("buildServer constructs without throwing", () => {
  expect(buildServer(deps)).toBeDefined();
});

test("the three registrars cover the full 14-tool surface", () => {
  const names: string[] = [];
  const spy = { registerTool: (n: string) => names.push(n) } as unknown as Parameters<typeof registerInfoTools>[0];
  registerInfoTools(spy, deps);
  registerTakerTools(spy, deps);
  registerMakerTools(spy, deps);
  expect(names.sort()).toEqual(
    [
      "get_status", "get_balances", "list_instruments", "get_reference_price", "request_faucet",
      "create_rfq", "list_my_rfqs", "get_quotes", "accept_quote", "cancel_rfq",
      "wait_for_rfq", "submit_quote", "list_maker_trades", "list_trades",
    ].sort(),
  );
});
