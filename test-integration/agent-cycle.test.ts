import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { makeApi, type DeskDto, type FaucetDripResult, type FaucetInfo, type InstrumentDto, type SignActionDto } from "../src/client.ts";
import { loadConfig } from "../src/config.ts";
import { register, type Identity } from "../src/identity.ts";
import { makeSigner, type Signer } from "../src/signer.ts";
import { makeRfqStream, type RfqStream } from "../src/stream.ts";

// A tiny in-process registrar spy: captures tool handlers so the test can call them.
type Handler = (a: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
function collect(
  registrar: (server: { registerTool: (n: string, c: unknown, h: Handler) => void }, deps: unknown) => void,
  deps: unknown,
): Map<string, Handler> {
  const h = new Map<string, Handler>();
  registrar({ registerTool: (n, _c, fn) => h.set(n, fn) }, deps);
  return h;
}

const BASE = process.env.RFQ_BASE_URL ?? "http://localhost:4000";
let deps: { cfg: ReturnType<typeof loadConfig>; api: ReturnType<typeof makeApi>; identity: Identity; signer: Signer; stream: RfqStream; log: (m: string) => void };

beforeAll(async () => {
  const stateFile = join(mkdtempSync(join(tmpdir(), "agent-int-")), "id.json");
  const cfg = { ...loadConfig({ RFQ_BASE_URL: BASE, AGENT_STATE_FILE: stateFile, AGENT_MAX_NOTIONAL: "100000000" }) };
  let identity: Identity | undefined;
  const api = makeApi(cfg.apiUrl, () => identity?.apiKey ?? "");
  const reg = await register(api, `agent-int-${Date.now()}`, stateFile);
  identity = reg.identity;
  const signer = makeSigner(api, identity, () => {});
  await signer.run(reg.actions);
  const pending = await api.get<{ actions: SignActionDto[] }>("/tx/pending");
  await signer.run(pending.actions);
  // Faucet the fresh agent so it can settle.
  const info = await api.get<FaucetInfo>("/faucet");
  if (info.enabled) await api.post<FaucetDripResult>("/faucet", undefined, 60_000);
  const stream = makeRfqStream(api.streamOptions, () => {});
  deps = { cfg, api, identity, signer, stream, log: () => {} };
}, 120_000);

afterAll(() => deps?.stream.close());

test("taker cycle: create_rfq is visible in list_my_rfqs", async () => {
  const { registerTakerTools } = await import("../src/tools/taker.ts");
  const h = collect(registerTakerTools as never, deps);
  const desk = await deps.api.get<DeskDto>("/desk");
  expect(desk.makers.length).toBeGreaterThan(0); // a maker (the demo bot) must be live to quote

  // Pick a valid, enabled pair from the live catalog (symbols vary per network).
  const instruments = await deps.api.get<InstrumentDto[]>("/instruments");
  expect(instruments.length).toBeGreaterThanOrEqual(2);
  const base = instruments[0].symbol;
  const quote = instruments.find((i) => i.symbol !== base)!.symbol;

  const created = await h.get("create_rfq")!({ direction: "SELL", base, quote, qty: "0.001", durationMinutes: 5 });
  expect(created.isError).toBeFalsy();
  const rfqId = JSON.parse(created.content[0].text).rfqId as string;

  const mine = await h.get("list_my_rfqs")!({});
  expect(mine.content[0].text).toContain(rfqId);
});

/** The full live cycle the unit suite can't cover: a freshly-registered agent
 * party SELLs to the sandbox demo maker and the swap settles atomically
 * on-ledger, with every taker-side signature going through the MCP signer.
 * The accept itself is the same POST the accept_quote tool issues; only the
 * checkRails gate is bypassed — the sandbox has no price oracle (COINGECKO
 * key unset -> referencePrice null -> fail-closed refusal by design), and
 * rails are a pure function with its own unit coverage. */
test("live accept→settle: agent sells to the demo maker, swap settles atomically", async () => {
  const { registerTakerTools } = await import("../src/tools/taker.ts");
  const h = collect(registerTakerTools as never, deps);

  // Fund the agent directly (sandbox MockRegistry mint, operator actAs) — the
  // faucet is DevNet-only. Party ids come from the ledger's own party list.
  const parties = await (await fetch("http://localhost:6864/v2/parties")).json() as { partyDetails?: Array<{ party: string }> } | Array<{ party: string }>;
  const list = Array.isArray(parties) ? parties : parties.partyDetails ?? [];
  const operator = list.map((p) => p.party).find((p) => p.startsWith("operator::"))!;
  expect(operator).toBeDefined();
  const mint = await fetch("http://localhost:6864/v2/commands/submit-and-wait-for-transaction", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      commands: {
        commands: [
          {
            CreateCommand: {
              templateId: "#rfq-desk:MockRegistry:MockHolding",
              createArguments: {
                admin: operator,
                owner: deps.identity.partyId,
                instrumentId: { admin: operator, id: "CBTC" },
                amount: "1.0",
              },
            },
          },
        ],
        commandId: `agent-int-fund-${Date.now()}`,
        userId: "participant_admin",
        actAs: [operator],
        readAs: [],
      },
      transactionFormat: {
        eventFormat: {
          filtersByParty: { [operator]: { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] } },
          verbose: false,
        },
        transactionShape: "TRANSACTION_SHAPE_ACS_DELTA",
      },
    }),
  });
  expect(mint.status).toBe(200);

  // The agent asks the demo maker for a price.
  const created = await h.get("create_rfq")!({ direction: "SELL", base: "cbtc", quote: "usdcx", qty: "0.001", durationMinutes: 5, makers: ["makerA"] });
  expect(created.isError).toBeFalsy();
  const rfqId = JSON.parse(created.content[0].text).rfqId as string;

  // The live counterparty quotes via the Maker API (sandbox demo key).
  const quoted = await fetch(`${BASE}/maker/quotes`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "demo-key-a" },
    body: JSON.stringify({ rfqId, price: "60000.0", validUntil: new Date(Date.now() + 4 * 60_000).toISOString() }),
  });
  expect(quoted.status).toBe(200);
  const quoteId = (await quoted.json() as { quoteId: string }).quoteId;

  // The operator's sweep must first accept the agent's UserService activation.
  const actDeadline = Date.now() + 60_000;
  for (;;) {
    const status = await deps.api.get<{ serviceActivated: boolean }>("/maker/status");
    if (status.serviceActivated) break;
    if (Date.now() > actDeadline) throw new Error("agent UserService not activated within 60s");
    await new Promise((r) => setTimeout(r, 1500));
  }

  // Accept (the same POST accept_quote issues), then keep draining /tx/pending
  // through the MCP signer until the trade leaves "settling" — the runtime's
  // stream-driven signer loop, compressed into a poll.
  const trade = await deps.api.post<{ tradeId: string; status?: string }>(`/quote/${encodeURIComponent(quoteId)}/accept`);
  const deadline = Date.now() + 90_000;
  let settled: { tradeId: string; status?: string; settledAt: string; qty: string } | undefined;
  for (;;) {
    const pending = await deps.api.get<{ actions: SignActionDto[] }>("/tx/pending");
    await deps.signer.run(pending.actions);
    const trades = await deps.api.get<Array<{ tradeId: string; status?: string; settledAt: string; qty: string }>>("/trades?limit=100");
    const t = trades.find((x) => x.tradeId === trade.tradeId);
    if (t !== undefined && t.status !== "settling") {
      settled = t;
      break;
    }
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  expect(settled, "trade did not settle within 90s").toBeDefined();
  expect(settled!.settledAt).not.toBe("");
  expect(settled!.qty).toBe("0.001");
}, 150_000);
