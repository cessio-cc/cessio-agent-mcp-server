import { expect, test, vi } from "vitest";
import type { Api, TradeDto } from "../src/client.ts";
import { pollSettlement } from "../src/settle.ts";

const trade = (status?: "settled" | "settling"): TradeDto => ({
  tradeId: "t1", taker: "tk", maker: "mk", direction: "SELL", qty: "1", base: "cBTC", quote: "USDC",
  price: "50000", fee: "1", settledAt: status === "settling" ? "" : "2026-07-26T00:00:00Z", status,
});

function apiReturning(pages: TradeDto[][]): Api {
  let i = 0;
  const get = vi.fn(async () => pages[Math.min(i++, pages.length - 1)]);
  return { get: get as unknown as Api["get"], post: vi.fn(), del: vi.fn(), streamOptions: () => ({ url: "ws://x", headers: {} }) };
}

const fastClock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
};

test("returns settled once the trade leaves 'settling'", async () => {
  const { now, sleep } = fastClock();
  const api = apiReturning([[trade("settling")], [trade("settling")], [trade("settled")]]);
  const out = await pollSettlement(api, "t1", 60_000, 1_000, now, sleep);
  expect(out.settled).toBe(true);
  expect(out.trade?.status).toBe("settled");
});

test("times out and returns the still-settling trade", async () => {
  const { now, sleep } = fastClock();
  const api = apiReturning([[trade("settling")]]);
  const out = await pollSettlement(api, "t1", 3_000, 1_000, now, sleep);
  expect(out.settled).toBe(false);
  expect(out.trade?.status).toBe("settling");
});
