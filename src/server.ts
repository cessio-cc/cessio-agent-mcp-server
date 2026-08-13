import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Deps } from "./tools/deps.ts";
import { registerInfoTools } from "./tools/info.ts";
import { registerMakerTools } from "./tools/maker.ts";
import { registerTakerTools } from "./tools/taker.ts";

export function buildServer(deps: Deps): McpServer {
  const server = new McpServer({ name: "agent-mcp-server", version: "0.1.0" });
  registerInfoTools(server, deps);
  registerTakerTools(server, deps);
  registerMakerTools(server, deps);
  return server;
}
