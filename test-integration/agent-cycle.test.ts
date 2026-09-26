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
  identity = await register(api, `agent-int-${Date.now()}`, stateFile);
  const signer = makeSigner(api, identity, () => {});
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

/** The rail's admin offers `amount` of `id` to `owner` on the local sandbox —
 * a deposit, as any token-standard sender would make one. Raw JSON Ledger API
 * as the operator (house party, the node signs for it). */
const LEDGER = process.env.LEDGER_JSON_API_URL ?? "http://localhost:6864";
const TOKEN_RULES = "#splice-test-token-v2:Splice.Testing.Tokens.TestTokenV2:TokenRules";
async function ledgerPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${LEDGER}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status, `${path}: ${res.status}`).toBe(200);
  return (await res.json()) as T;
}
async function offerMint(owner: string, id: string, amount: string): Promise<void> {
  const parties = (await (await fetch(`${LEDGER}/v2/parties`)).json()) as { partyDetails?: Array<{ party: string }> };
  const operator = (parties.partyDetails ?? []).map((p) => p.party).find((p) => p.startsWith("operator::"))!;
  expect(operator).toBeDefined();
  const { offset } = (await (await fetch(`${LEDGER}/v2/state/ledger-end`)).json()) as { offset: number };
  const acs = await ledgerPost<Array<{ contractEntry: { JsActiveContract?: { createdEvent: { contractId: string } } } }>>(
    "/v2/state/active-contracts",
    {
      filter: { filtersByParty: { [operator]: { cumulative: [{ identifierFilter: { TemplateFilter: { value: { templateId: TOKEN_RULES, includeCreatedEventBlob: false } } } }] } } },
      verbose: false,
      activeAtOffset: offset,
    },
  );
  const rulesCid = acs.map((e) => e.contractEntry.JsActiveContract?.createdEvent.contractId).find((c) => c !== undefined)!;
  const account = { owner, provider: null, id: "" };
  await ledgerPost("/v2/commands/submit-and-wait", {
    commands: [
      {
        ExerciseCommand: {
          templateId: TOKEN_RULES,
          contractId: rulesCid,
          choice: "TokenRules_OfferMint",
          choiceArgument: {
            receiver: account,
            amount,
            instrumentId: { admin: operator, id },
            offeredAt: new Date(Date.now() - 60_000).toISOString(),
            receiverConfig: {
              admin: operator,
              account,
              ownerConfig: { canInitiate: true, mustApprove: true },
              providerConfig: { canInitiate: false, mustApprove: false },
            },
          },
        },
      },
    ],
    commandId: `agent-int-fund-${Date.now()}`,
    userId: "participant_admin",
    actAs: [operator],
    readAs: [],
  });
}

/** The full live cycle the unit suite can't cover, through the real tools: a
 * freshly-registered agent party takes a deposit through the desk's inbox,
 * SELLs to the sandbox demo maker with accept_quote, and the swap settles
 * atomically on-ledger — every agent signature through the MCP signer. The
 * sandbox has no price oracle, so the reference-price read is answered here
 * to let the rails pass (they fail closed without one, by design). */
test("live accept_quote: agent sells to the demo maker, the tool returns the settled trade", async () => {
  const { registerTakerTools } = await import("../src/tools/taker.ts");
  const api = {
    ...deps.api,
    get: <T,>(path: string): Promise<T> =>
      path.startsWith("/maker/reference-price") ? Promise.resolve({ price: "60000.0" } as T) : deps.api.get<T>(path),
  };
  const h = collect(registerTakerTools as never, { ...deps, api });

  // Fund: the deposit waits in the inbox; accepting it hands back one action to sign.
  await offerMint(deps.identity.partyId, "CBTC", "1.0");
  let cid: string | undefined;
  for (let i = 0; i < 60 && cid === undefined; i++) {
    const { transfers } = await deps.api.get<{ transfers: Array<{ cid: string }> }>("/wallet/incoming");
    cid = transfers[0]?.cid;
    if (cid === undefined) await new Promise((r) => setTimeout(r, 500));
  }
  expect(cid, "the deposit never reached /wallet/incoming").toBeDefined();
  const { actions } = await deps.api.post<{ actions: SignActionDto[] }>(`/wallet/incoming/${cid}/accept`);
  await deps.signer.run(actions);

  // The agent asks the demo maker for a price; the maker quotes via the Maker API.
  const created = await h.get("create_rfq")!({ direction: "SELL", base: "cBTC", quote: "USDCx", qty: "0.001", durationMinutes: 5, makers: ["makerA"] });
  expect(created.isError).toBeFalsy();
  const rfqId = JSON.parse(created.content[0].text).rfqId as string;
  const quoted = await fetch(`${BASE}/maker/quotes`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "demo-key-a" },
    body: JSON.stringify({ rfqId, price: "60000.0" }),
  });
  expect(quoted.status).toBe(200);
  const quoteId = ((await quoted.json()) as { quoteId: string }).quoteId;

  const res = await h.get("accept_quote")!({ quoteId });
  expect(res.isError, res.content[0].text).toBeFalsy();
  const trade = JSON.parse(res.content[0].text) as { tradeId: string; qty: string; settledAt: string; ledger?: { updateId: string } };
  expect(trade.tradeId).toBe(quoteId);
  expect(trade.qty).toBe("0.001");
  expect(trade.settledAt).not.toBe("");
  expect(trade.ledger?.updateId).toBeTruthy();
}, 150_000);
