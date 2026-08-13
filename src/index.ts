#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { makeApi, type SignActionDto } from "./client.ts";
import { loadConfig } from "./config.ts";
import { loadIdentity, recoverApiKey, register, type Identity } from "./identity.ts";
import { buildServer } from "./server.ts";
import { makeSigner } from "./signer.ts";
import { makeRfqStream } from "./stream.ts";

// stdout is the MCP channel — every log line goes to stderr.
export const NAME = "@cessio/agent-mcp-server";
const log = (msg: string): void => console.error(`[${new Date().toISOString()}] ${msg}`);

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  let identity: Identity | undefined = loadIdentity(cfg.stateFile);
  const api = makeApi(cfg.apiUrl, () => identity?.apiKey ?? "");

  if (identity !== undefined && identity.apiKey === "") {
    log("identity has no API key — recovering via challenge + rotate");
    identity = await recoverApiKey(api, cfg.stateFile);
  }
  let initialActions: SignActionDto[] = [];
  if (identity === undefined) {
    log(`no identity at ${cfg.stateFile} — registering "${cfg.displayName}" at ${cfg.apiUrl}`);
    ({ identity, actions: initialActions } = await register(api, cfg.displayName, cfg.stateFile));
    log(`registered as ${identity.hint} (${identity.partyId})`);
  }
  const id = identity;
  const signer = makeSigner(api, id, log);

  // Sign registration/activation actions, then drain anything parked in the queue.
  await signer.run(initialActions).catch((e) => log(`initial sign failed (will retry via /tx/pending): ${String(e)}`));
  try {
    const pending = await api.get<{ actions: SignActionDto[] }>("/tx/pending");
    await signer.run(pending.actions);
  } catch (e) {
    log(`initial /tx/pending drain failed: ${String(e)}`);
  }

  const stream = makeRfqStream(api.streamOptions, log);
  const server = buildServer({ cfg, api, identity: id, signer, stream, log });

  await server.connect(new StdioServerTransport());
  log(`agent-mcp-server ready — maker ${id.hint}, desk ${cfg.apiUrl}, maxNotional ${cfg.maxNotional ?? "unset (trading disabled)"}`);
}

// Only run the server when executed directly, so tests can import NAME cheaply.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
