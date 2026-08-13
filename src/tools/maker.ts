import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MakerQuoteResponse, RfqDto, TradeDto } from "../client.ts";
import { checkRails } from "../guards.ts";
import { err, ok, refPrice, toToolError, type Deps } from "./deps.ts";

/** /rfq/incoming rows are RfqDto plus the maker's own quote (or null). */
interface IncomingRfq extends RfqDto {
  myQuote: unknown;
}

export function registerMakerTools(server: McpServer, deps: Deps): void {
  const { api, cfg, signer, stream } = deps;

  server.registerTool(
    "wait_for_rfq",
    {
      title: "Wait for the next incoming RFQ",
      description:
        "Blocks up to timeoutSeconds for the next RFQ addressed to this maker, then returns it (with its deadline) so you can decide a price and call submit_quote. Returns a no-RFQ note on timeout. Call it in a loop to make markets.",
      inputSchema: { timeoutSeconds: z.number().int().min(1).max(300).default(30) },
    },
    async ({ timeoutSeconds }) => {
      try {
        const rfq = await stream.next(timeoutSeconds * 1_000);
        return rfq === null ? ok({ rfq: null, note: "no RFQ within the timeout — call wait_for_rfq again" }) : ok(rfq);
      } catch (e) {
        return toToolError(e);
      }
    },
  );

  server.registerTool(
    "submit_quote",
    {
      title: "Submit a quote",
      description:
        "Quote a price on an incoming RFQ (price = quote units per 1 base). Checked against the operator rails, then signed and published. Use the rfqId from wait_for_rfq.",
      inputSchema: { rfqId: z.string(), price: z.string() },
    },
    async ({ rfqId, price }) => {
      try {
        let rfq: RfqDto | undefined = stream.get(rfqId);
        if (rfq === undefined) {
          const incoming = await api.get<IncomingRfq[]>("/rfq/incoming");
          rfq = incoming.find((r) => r.rfqId === rfqId);
        }
        if (rfq === undefined) return err(`RFQ ${rfqId} is not addressed to this maker (or has closed)`);

        const mid = await refPrice(api, rfq.base, rfq.quote);
        const rail = checkRails({ base: rfq.base, quote: rfq.quote, qty: rfq.qty, price }, mid, cfg);
        if (!rail.ok) return err(`refused by rails: ${rail.reason}`);

        // validUntil omitted: the desk defaults it to min(now + desk TTL, deadline).
        const quote = await api.post<MakerQuoteResponse>("/maker/quotes", { rfqId, price });
        await signer.run(quote.actions);
        return ok({ quoteId: quote.quoteId, rfqId: quote.rfqId, price: quote.price, status: quote.status });
      } catch (e) {
        return toToolError(e);
      }
    },
  );

  server.registerTool(
    "list_maker_trades",
    { title: "List maker trades", description: "Trades this agent won as a maker.", inputSchema: {} },
    async () => {
      try {
        return ok(await api.get<TradeDto[]>("/maker/trades"));
      } catch (e) {
        return toToolError(e);
      }
    },
  );

  server.registerTool(
    "list_trades",
    { title: "List trades", description: "The agent's recent settled trades (either role).", inputSchema: {} },
    async () => {
      try {
        return ok(await api.get<TradeDto[]>("/trades?limit=100"));
      } catch (e) {
        return toToolError(e);
      }
    },
  );
}
