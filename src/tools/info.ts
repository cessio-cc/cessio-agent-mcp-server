import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BalancesDto, FaucetDripResult, FaucetInfo, InstrumentDto, MakerStatusResponse } from "../client.ts";
import { ok, refPrice, toToolError, type Deps } from "./deps.ts";

export function registerInfoTools(server: McpServer, deps: Deps): void {
  const { api } = deps;

  server.registerTool(
    "get_status",
    { title: "Get agent status", description: "This agent's party hint, activation state, and pending sign actions.", inputSchema: {} },
    async () => {
      try {
        return ok(await api.get<MakerStatusResponse>("/maker/status"));
      } catch (e) {
        return toToolError(e);
      }
    },
  );

  server.registerTool(
    "get_balances",
    { title: "Get balances", description: "The agent's on-ledger holdings per instrument.", inputSchema: {} },
    async () => {
      try {
        return ok(await api.get<BalancesDto>("/wallet/holdings"));
      } catch (e) {
        return toToolError(e);
      }
    },
  );

  server.registerTool(
    "list_instruments",
    { title: "List instruments", description: "The tradeable catalog (base/quote symbols) on the desk.", inputSchema: {} },
    async () => {
      try {
        return ok(await api.get<InstrumentDto[]>("/instruments"));
      } catch (e) {
        return toToolError(e);
      }
    },
  );

  server.registerTool(
    "get_reference_price",
    {
      title: "Get reference price",
      description: "The desk oracle mid for a base/quote pair (price per 1 base, in quote), or null if unavailable.",
      inputSchema: { base: z.string(), quote: z.string() },
    },
    async ({ base, quote }) => {
      try {
        return ok({ base, quote, price: await refPrice(api, base, quote) });
      } catch (e) {
        return toToolError(e);
      }
    },
  );

  server.registerTool(
    "request_faucet",
    { title: "Request faucet drip", description: "On DevNet, top up the agent's demo balances (no-op where the faucet is disabled).", inputSchema: {} },
    async () => {
      try {
        const info = await api.get<FaucetInfo>("/faucet");
        if (!info.enabled) return ok({ enabled: false, note: "faucet is not enabled on this network" });
        if (info.retryAfterSeconds > 0) return ok({ enabled: true, retryAfterSeconds: info.retryAfterSeconds, note: "cooling down" });
        return ok(await api.post<FaucetDripResult>("/faucet", undefined, 60_000));
      } catch (e) {
        return toToolError(e);
      }
    },
  );
}
