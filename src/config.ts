import { homedir } from "node:os";
import { join } from "node:path";

export interface AgentConfig {
  apiUrl: string;
  stateFile: string;
  displayName: string;
  maxNotional: number | null;
  instrumentWhitelist: string[];
  maxPriceDeviationBps: number;
  settleTimeoutMs: number;
  pollMs: number;
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number, got "${raw}"`);
  return n;
}

/** Pure env → typed config (mirrors apps/api/src/config.ts: no dotenv, no I/O). */
export function loadConfig(env: NodeJS.ProcessEnv): AgentConfig {
  const notionalRaw = env.AGENT_MAX_NOTIONAL;
  let maxNotional: number | null = null;
  if (notionalRaw !== undefined && notionalRaw !== "") {
    const n = Number(notionalRaw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`AGENT_MAX_NOTIONAL must be a positive number, got "${notionalRaw}"`);
    maxNotional = n;
  }
  return {
    apiUrl: env.RFQ_BASE_URL ?? "http://localhost:4000",
    stateFile: env.AGENT_STATE_FILE ?? join(homedir(), ".cessio", "agent-identity.json"),
    displayName: env.AGENT_DISPLAY_NAME ?? "agent",
    maxNotional,
    // Catalog symbols, compared case-insensitively: "cBTC" and "cbtc" are the same.
    instrumentWhitelist: (env.AGENT_INSTRUMENT_WHITELIST ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s !== ""),
    maxPriceDeviationBps: num(env, "AGENT_MAX_PRICE_DEVIATION_BPS", 500),
    settleTimeoutMs: num(env, "AGENT_SETTLE_TIMEOUT_MS", 60_000),
    pollMs: num(env, "AGENT_POLL_MS", 1_500),
  };
}
