import { expect, test, vi } from "vitest";
import type { Api, RfqHistoryDto, TradeDto } from "../src/client.ts";
import { failedRowIds, pollSettlement } from "../src/settle.ts";

const trade = (): TradeDto => ({
  tradeId: "t1", taker: "tk", maker: "mk", direction: "SELL", qty: "1", base: "cbtc", quote: "usdcx",
  price: "50000", fee: "1", settledAt: "2026-07-26T00:00:00Z",
});
const failedRow = (id: string, reason = "the settlement window expired"): RfqHistoryDto => ({
  id, rfqId: "r1", kind: "failed", reason, at: "2026-07-26T00:00:00Z",
});

/** A desk whose GETs answer from per-path page sequences (the last page repeats). */
function desk(pages: { trades?: TradeDto[][]; history?: RfqHistoryDto[][] }): Api {
  const at = { trades: 0, history: 0 };
  const next = <T,>(list: T[][] | undefined, key: "trades" | "history"): T[] => {
    const l = list ?? [[]];
    return l[Math.min(at[key]++, l.length - 1)]!;
  };
  const get = vi.fn(async (path: string) => (path.startsWith("/trades") ? next(pages.trades, "trades") : next(pages.history, "history")));
  return { get: get as unknown as Api["get"], post: vi.fn(), del: vi.fn(), streamOptions: () => ({ url: "ws://x", headers: {} }) };
}

const fastClock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
};
const watch = { tradeId: "t1", rfqId: "r1", priorFailures: new Set<string>() };
const noop = async (): Promise<void> => {};

test("returns the settled trade once it is recorded", async () => {
  const { now, sleep } = fastClock();
  const out = await pollSettlement(desk({ trades: [[], [], [trade()]] }), watch, 60_000, 1_000, noop, now, sleep);
  expect(out).toMatchObject({ settled: true, trade: { tradeId: "t1" } });
});

test("reports a failure recorded for the RFQ after the accept, with the desk's reason", async () => {
  const { now, sleep } = fastClock();
  const api = desk({ history: [[failedRow("old")], [failedRow("old"), failedRow("new")]] });
  const out = await pollSettlement(api, { ...watch, priorFailures: new Set(["old"]) }, 60_000, 1_000, noop, now, sleep);
  expect(out).toMatchObject({ settled: false, failure: "the settlement window expired" });
});

test("runs beforeEach every round — the taker tool signs late actions there", async () => {
  const { now, sleep } = fastClock();
  const beforeEach = vi.fn(noop);
  await pollSettlement(desk({ trades: [[], [], [trade()]] }), watch, 60_000, 1_000, beforeEach, now, sleep);
  expect(beforeEach).toHaveBeenCalledTimes(3);
});

test("times out as still settling", async () => {
  const { now, sleep } = fastClock();
  const out = await pollSettlement(desk({}), watch, 3_000, 1_000, noop, now, sleep);
  expect(out).toEqual({ trade: undefined, settled: false });
});

test("failedRowIds keeps only this RFQ's failed rows", async () => {
  const api = desk({ history: [[failedRow("a"), { ...failedRow("b"), rfqId: "other" }, { ...failedRow("c"), kind: "expired" }]] });
  expect([...(await failedRowIds(api, "r1"))]).toEqual(["a"]);
});
