import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AcceptQuoteResponse, DeskDto, RfqWithQuotesDto, SignActionDto } from "../client.ts";
import { checkRails } from "../guards.ts";
import { failedRowIds, pollSettlement } from "../settle.ts";
import { err, ok, refPrice, toToolError, type Deps } from "./deps.ts";

export function registerTakerTools(server: McpServer, deps: Deps): void {
  const { api, cfg, identity, signer } = deps;

  server.registerTool(
    "create_rfq",
    {
      title: "Create an RFQ",
      description:
        "Request quotes for a base/quote swap. direction is from the taker's side: SELL = you sell the base for quote; BUY = you buy the base with quote. `makers` defaults to every desk maker except yourself.",
      inputSchema: {
        direction: z.enum(["BUY", "SELL"]),
        base: z.string(),
        quote: z.string(),
        qty: z.string(),
        durationMinutes: z.number().int().min(1).max(60).default(5),
        makers: z.array(z.string()).optional(),
      },
    },
    async ({ direction, base, quote, qty, durationMinutes, makers }) => {
      try {
        let invitedMakers = makers;
        if (invitedMakers === undefined || invitedMakers.length === 0) {
          const desk = await api.get<DeskDto>("/desk");
          invitedMakers = desk.makers.filter((m) => m !== identity.hint);
        }
        if (invitedMakers.length === 0) return err("no makers available to invite");
        const rfq = await api.post<{ rfqId: string }>("/rfq", {
          direction,
          base,
          quote,
          qty,
          invitedMakers,
          ttlSeconds: durationMinutes * 60,
        });
        return ok(rfq);
      } catch (e) {
        return toToolError(e);
      }
    },
  );

  server.registerTool(
    "list_my_rfqs",
    { title: "List my RFQs", description: "The agent's own RFQs with the quotes received on each.", inputSchema: {} },
    async () => {
      try {
        return ok(await api.get<RfqWithQuotesDto[]>("/rfq/mine"));
      } catch (e) {
        return toToolError(e);
      }
    },
  );

  server.registerTool(
    "get_quotes",
    { title: "Get quotes for an RFQ", description: "The quotes received on one of your RFQs.", inputSchema: { rfqId: z.string() } },
    async ({ rfqId }) => {
      try {
        const mine = await api.get<RfqWithQuotesDto[]>("/rfq/mine");
        const rfq = mine.find((r) => r.rfqId === rfqId);
        if (rfq === undefined) return err(`no RFQ ${rfqId} owned by this agent`);
        return ok(rfq.quotes);
      } catch (e) {
        return toToolError(e);
      }
    },
  );

  server.registerTool(
    "accept_quote",
    {
      title: "Accept a quote",
      description:
        "Accept a maker's quote on your RFQ. Signs your side of the settlement and waits for the outcome: the settled trade with its on-ledger proof, or the reason the desk failed it (nothing moves on a failure; the RFQ stays open until its deadline).",
      inputSchema: { quoteId: z.string() },
    },
    async ({ quoteId }) => {
      try {
        // Find the quote + its RFQ for the rail check.
        const mine = await api.get<RfqWithQuotesDto[]>("/rfq/mine");
        const rfq = mine.find((r) => r.quotes.some((q) => q.quoteId === quoteId));
        const quote = rfq?.quotes.find((q) => q.quoteId === quoteId);
        if (rfq === undefined || quote === undefined) return err(`quote ${quoteId} not found on any of your RFQs`);

        const mid = await refPrice(api, rfq.base, rfq.quote);
        const rail = checkRails({ base: rfq.base, quote: rfq.quote, qty: rfq.qty, price: quote.price }, mid, cfg);
        if (!rail.ok) return err(`refused by rails: ${rail.reason}`);

        const priorFailures = await failedRowIds(api, rfq.rfqId);
        const trade = await api.post<AcceptQuoteResponse>(`/quote/${encodeURIComponent(quoteId)}/accept`);
        // The accept hands back the taker's allocations: sign them now. The wait
        // re-drains /tx/pending, for one the desk could only queue a moment later.
        await signer.run(trade.actions ?? []);
        const drain = async (): Promise<void> => {
          const pending = await api.get<{ actions: SignActionDto[] }>("/tx/pending");
          await signer.run(pending.actions);
        };
        const outcome = await pollSettlement(
          api, { tradeId: trade.tradeId, rfqId: rfq.rfqId, priorFailures }, cfg.settleTimeoutMs, cfg.pollMs, drain,
        );
        if (outcome.settled) return ok(outcome.trade);
        if (outcome.failure !== undefined) return err(`settlement failed: ${outcome.failure} — nothing moved; the RFQ stays open until its deadline`);
        const { actions: _signed, ...settling } = trade;
        return ok({ ...(outcome.trade ?? settling), note: "still settling — check list_trades" });
      } catch (e) {
        return toToolError(e);
      }
    },
  );

  server.registerTool(
    "cancel_rfq",
    { title: "Cancel an RFQ", description: "Cancel one of your open RFQs.", inputSchema: { rfqId: z.string() } },
    async ({ rfqId }) => {
      try {
        await api.del(`/rfq/${encodeURIComponent(rfqId)}`);
        return ok({ rfqId, cancelled: true });
      } catch (e) {
        return toToolError(e);
      }
    },
  );
}
