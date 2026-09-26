import type { Api, RfqHistoryDto, TradeDto } from "./client.ts";

export interface SettleOutcome {
  trade: TradeDto | undefined;
  settled: boolean;
  /** The desk's reason when it failed the trade — dead, nothing moved. */
  failure?: string;
}

/** The accepted trade the wait watches. `priorFailures` are the RFQ's failed
 * rows from before the accept, so an earlier attempt is not mistaken for this one. */
export interface SettleWatch {
  tradeId: string;
  rfqId: string;
  priorFailures: Set<string>;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Ids of the RFQ's "failed" history rows — taken right before the accept. */
export async function failedRowIds(api: Api, rfqId: string): Promise<Set<string>> {
  const rows = await api.get<RfqHistoryDto[]>("/rfq-history?limit=100");
  return new Set(rows.filter((r) => r.rfqId === rfqId && r.kind === "failed").map((r) => r.id));
}

/** Polls until the trade settles (it appears in GET /trades) or the desk fails
 * it (a new "failed" row for its RFQ in GET /rfq-history), or the timeout
 * elapses — then it returns the last-seen trade so the tool can say "still
 * settling" instead of hanging the MCP client. `beforeEach` runs first on
 * every round: the taker tool signs whatever the desk queued meanwhile. */
export async function pollSettlement(
  api: Api,
  watch: SettleWatch,
  timeoutMs: number,
  pollMs: number,
  beforeEach: () => Promise<void> = async () => {},
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<SettleOutcome> {
  const deadline = now() + timeoutMs;
  let last: TradeDto | undefined;
  for (;;) {
    await beforeEach();
    const trades = await api.get<TradeDto[]>("/trades?limit=100");
    last = trades.find((t) => t.tradeId === watch.tradeId) ?? last;
    if (last !== undefined && last.status !== "settling") return { trade: last, settled: true };
    const history = await api.get<RfqHistoryDto[]>("/rfq-history?limit=100");
    const failed = history.find((r) => r.rfqId === watch.rfqId && r.kind === "failed" && !watch.priorFailures.has(r.id));
    if (failed !== undefined) return { trade: last, settled: false, failure: failed.reason ?? "settlement failed" };
    if (now() >= deadline) return { trade: last, settled: false };
    await sleep(pollMs);
  }
}
