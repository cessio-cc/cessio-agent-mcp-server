import { expect, test } from "vitest";
import { loadConfig } from "../src/config.ts";

test("defaults with an empty env", () => {
  const c = loadConfig({});
  expect(c.apiUrl).toBe("http://localhost:4000");
  expect(c.displayName).toBe("agent");
  expect(c.maxNotional).toBeNull();
  expect(c.instrumentWhitelist).toEqual([]);
  expect(c.maxPriceDeviationBps).toBe(500);
  expect(c.settleTimeoutMs).toBe(60_000);
  expect(c.pollMs).toBe(1_500);
  expect(c.stateFile.endsWith("/.cessio/agent-identity.json")).toBe(true);
});

test("parses overrides", () => {
  const c = loadConfig({
    RFQ_BASE_URL: "https://desk.example",
    AGENT_DISPLAY_NAME: "quant-1",
    AGENT_MAX_NOTIONAL: "5000",
    AGENT_INSTRUMENT_WHITELIST: "cBTC, USDC ,cETH",
    AGENT_MAX_PRICE_DEVIATION_BPS: "250",
    AGENT_SETTLE_TIMEOUT_MS: "30000",
    AGENT_POLL_MS: "1000",
    AGENT_STATE_FILE: "/tmp/id.json",
  });
  expect(c.apiUrl).toBe("https://desk.example");
  expect(c.displayName).toBe("quant-1");
  expect(c.maxNotional).toBe(5000);
  expect(c.instrumentWhitelist).toEqual(["cbtc", "usdc", "ceth"]); // symbols compare case-insensitively
  expect(c.maxPriceDeviationBps).toBe(250);
  expect(c.settleTimeoutMs).toBe(30_000);
  expect(c.pollMs).toBe(1_000);
  expect(c.stateFile).toBe("/tmp/id.json");
});

test("rejects a non-numeric notional", () => {
  expect(() => loadConfig({ AGENT_MAX_NOTIONAL: "abc" })).toThrow(/AGENT_MAX_NOTIONAL/);
});
