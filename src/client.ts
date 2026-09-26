/** The subset of docs/openapi.yaml this server touches. Deliberately local
 * types: the server plays a third-party integrator coded against the public
 * spec, not against the desk's internal @rfq/shared schemas. */

export type Direction = "BUY" | "SELL";

/** base64 bytes of a Canton prepared-transaction hash — sign the RAW bytes. */
export interface SignActionDto {
  id: string;
  /** `allocate`: a token-standard v2 allocation (a quote or accept leg);
   * `transfer-accept`: a deposit; `transfer-out`: a withdrawal. */
  purpose: "allocate" | "transfer-accept" | "transfer-out";
  description: string;
  hash: string;
}

export interface HoldingDto {
  symbol: string;
  displaySymbol: string;
  amount: string;
}

export interface BalancesDto {
  party: string;
  holdings: HoldingDto[];
}

export interface InstrumentDto {
  symbol: string;
  displaySymbol: string;
  decimals: number;
  logoUrl?: string;
}

export interface DeskDto {
  feeBps: number;
  makers: string[];
}

export interface QuoteDto {
  quoteId: string;
  rfqId: string;
  maker: string;
  price: string;
  validUntil: string;
  status: "pending" | "won" | "lost" | "expired" | "revoked";
  settling?: boolean;
}

export interface RfqDto {
  rfqId: string;
  taker: string;
  direction: Direction;
  qty: string;
  base: string;
  quote: string;
  deadline: string;
  invitedMakers: string[];
  feeBps: number;
  open: boolean;
}

export interface RfqWithQuotesDto extends RfqDto {
  quotes: QuoteDto[];
}

export interface TradeDto {
  tradeId: string;
  taker: string;
  maker: string;
  direction: Direction;
  qty: string;
  base: string;
  quote: string;
  price: string;
  fee: string;
  settledAt: string;
  ledger?: { updateId: string; receiptCids: string[] };
  status?: "settled" | "settling";
}

/** POST /quote/:id/accept — the settling trade plus the taker's own
 * allocations to sign (none when the desk allocates for the party). */
export interface AcceptQuoteResponse extends TradeDto {
  actions: SignActionDto[];
}

/** GET /rfq-history — a no-trade outcome of one of your RFQs. A failed trade
 * leaves a "failed" row with the desk's reason. */
export interface RfqHistoryDto {
  id: string;
  rfqId: string;
  kind: "expired" | "cancelled" | "failed";
  reason?: string;
  at: string;
}

export interface MakerQuoteResponse {
  quoteId: string;
  rfqId: string;
  price: string;
  status: QuoteDto["status"];
  /** The maker's token-standard v2 allocations to sign, one per instrument
   * the quote touches; the taker sees nothing until every one has landed. */
  actions: SignActionDto[];
}

export interface TxExecuteBatchResponse {
  results: { actionId: string; status: "executed" | "in-flight" | "error"; error?: string; retryable?: boolean }[];
}

export interface MakerStatusResponse {
  partyId: string;
  hint: string;
  invitable: boolean;
  pendingActions: number;
}

export interface MakerRegisterStartResponse {
  registrationId: string;
  partyId: string;
  topology: { hash: string; description: string }[];
}

export interface MakerRegisterCompleteResponse {
  partyId: string;
  hint: string;
  apiKey: string;
}

export interface ReferencePrice {
  price: string | null;
}

export interface FaucetInfo {
  enabled: boolean;
  retryAfterSeconds: number;
  drip: { symbol: string; displaySymbol: string; amount: string }[];
}

export interface FaucetDripResult {
  sent: { symbol: string; amount: string }[];
  skipped: { symbol: string; reason: string }[];
}

/** One /maker/stream message; payload shape depends on `type` (see openapi). */
export interface WsEvent {
  type: string;
  payload: unknown;
}

export class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, call: string) {
    super(`${call} -> ${status}: ${body}`);
    this.status = status;
    this.body = body;
  }
}

export interface Api {
  get<T>(path: string): Promise<T>;
  /** Raise `timeoutMs` only for calls that do many ledger round-trips. */
  post<T>(path: string, body?: unknown, timeoutMs?: number): Promise<T>;
  del(path: string): Promise<void>;
  /** Node WebSocket upgrade options for the authenticated maker stream. */
  streamOptions(): { url: string; headers: Record<string, string> };
}

/** Thin fetch client. `apiKey` is read per call so the client can exist before
 * registration has produced a key. Non-2xx throws HttpError. Every call is
 * time-bounded so one hung socket can't stall a tool for minutes. */
export function makeApi(baseUrl: string, apiKey: () => string): Api {
  async function call<T>(method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
    const key = apiKey();
    const res = await fetch(baseUrl + path, {
      method,
      headers: {
        // content-type only WITH a body: fastify 400s an empty json-typed body.
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(key === "" ? {} : { "x-api-key": key }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, text, `${method} ${path}`);
    return (text === "" ? undefined : JSON.parse(text)) as T;
  }
  return {
    get: (path) => call("GET", path),
    post: (path, body, timeoutMs) => call("POST", path, body, timeoutMs),
    del: async (path) => {
      await call("DELETE", path);
    },
    streamOptions: () => ({
      url: `${baseUrl.replace(/^http/, "ws")}/maker/stream`,
      headers: { "x-api-key": apiKey() },
    }),
  };
}
