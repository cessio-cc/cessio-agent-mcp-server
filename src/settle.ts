import type { Api, TradeDto } from "./client.ts";

export interface SettleOutcome {
  trade: TradeDto | undefined;
  settled: boolean;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Polls GET /trades until `tradeId` is terminal (status !== "settling") or the
 * timeout elapses. On timeout returns the last-seen (still settling) trade so
 * the tool can say "still settling" instead of hanging the MCP client. */
export async function pollSettlement(
  api: Api,
  tradeId: string,
  timeoutMs: number,
  pollMs: number,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<SettleOutcome> {
  const deadline = now() + timeoutMs;
  let last: TradeDto | undefined;
  for (;;) {
    const trades = await api.get<TradeDto[]>("/trades?limit=100");
    last = trades.find((t) => t.tradeId === tradeId) ?? last;
    if (last !== undefined && last.status !== "settling") return { trade: last, settled: true };
    if (now() >= deadline) return { trade: last, settled: false };
    await sleep(pollMs);
  }
}
