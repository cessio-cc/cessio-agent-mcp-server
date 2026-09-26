import { expect, test } from "vitest";
import { checkRails, type RailConfig } from "../src/guards.ts";

const rails: RailConfig = { maxNotional: 1000, instrumentWhitelist: ["cBTC", "USDC"], maxPriceDeviationBps: 500 };
const intent = { base: "cBTC", quote: "USDC", qty: "0.01", price: "50000" }; // notional 500

test("passes within all rails", () => {
  expect(checkRails(intent, "50000", rails)).toEqual({ ok: true });
  expect(checkRails(intent, "48000", rails)).toEqual({ ok: true }); // ~416 bps, under 500
});

test("refuses when trading is disabled (maxNotional null)", () => {
  const r = checkRails(intent, "50000", { ...rails, maxNotional: null });
  expect(r).toMatchObject({ ok: false });
  if (!r.ok) expect(r.reason).toMatch(/AGENT_MAX_NOTIONAL/);
});

test("refuses an instrument off the whitelist", () => {
  const r = checkRails({ ...intent, base: "cETH" }, "50000", rails);
  expect(r).toMatchObject({ ok: false });
  if (!r.ok) expect(r.reason).toMatch(/cETH/);
});

test("the whitelist ignores case — display and catalog symbols are the same instrument", () => {
  expect(checkRails({ ...intent, base: "cbtc", quote: "usdc" }, "50000", rails)).toEqual({ ok: true });
});

test("refuses over the notional ceiling", () => {
  const r = checkRails({ ...intent, qty: "0.1" }, "50000", rails); // notional 5000
  expect(r).toMatchObject({ ok: false });
  if (!r.ok) expect(r.reason).toMatch(/notional/i);
});

test("fails closed when the oracle price is unavailable", () => {
  const r = checkRails(intent, null, rails);
  expect(r).toMatchObject({ ok: false });
  if (!r.ok) expect(r.reason).toMatch(/reference|oracle/i);
});

test("refuses a price outside the deviation band", () => {
  const r = checkRails({ ...intent, price: "60000" }, "50000", rails); // 2000 bps
  expect(r).toMatchObject({ ok: false });
  if (!r.ok) expect(r.reason).toMatch(/deviat/i);
});

test("an empty whitelist allows any instrument", () => {
  expect(checkRails({ ...intent, base: "cETH" }, "50000", { ...rails, instrumentWhitelist: [] })).toEqual({ ok: true });
});
