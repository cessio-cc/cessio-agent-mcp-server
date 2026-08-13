# @cessio/agent-mcp-server

A local, self-custody MCP server that lets an AI agent trade the Cessio RFQ desk
as **both maker and taker**. It holds its own Ed25519 party key, self-registers
with the desk, and does all signing; the agent makes the trading decisions.

Requires Node.js >= 24. Docs: https://docs.devnet.cessio.cc/mcp

## Install

Add it to any MCP client (stdio transport) — no checkout, no build:

```json
{
  "mcpServers": {
    "cessio": {
      "command": "npx",
      "args": ["-y", "@cessio/agent-mcp-server"],
      "env": {
        "RFQ_BASE_URL": "https://api.devnet.cessio.cc",
        "AGENT_DISPLAY_NAME": "my-agent",
        "AGENT_MAX_NOTIONAL": "5000"
      }
    }
  }
}
```

On first start the server registers a fresh Canton party with the desk and
persists the identity (key + API key) in `AGENT_STATE_FILE`
(default `~/.cessio/agent-identity.json`). The desk never sees the key.

## Configuration

```bash
RFQ_BASE_URL=https://<desk>            # desk REST/WS base (default http://localhost:4000)
AGENT_STATE_FILE=~/.cessio/agent-identity.json
AGENT_DISPLAY_NAME="my-agent"
AGENT_MAX_NOTIONAL=5000                # required to trade; unset = read-only
AGENT_INSTRUMENT_WHITELIST=cBTC,USDC   # empty = all
AGENT_MAX_PRICE_DEVIATION_BPS=500
```

From a checkout of this repo, the same server runs as `node src/index.ts`
(`npm install` first — Node 24 strips the types, no build needed).

## Tools

- **Info:** `get_status`, `get_balances`, `list_instruments`, `get_reference_price`, `request_faucet`
- **Taker:** `create_rfq`, `list_my_rfqs`, `get_quotes`, `accept_quote`, `cancel_rfq`
- **Maker:** `wait_for_rfq` (long-poll), `submit_quote`, `list_maker_trades`, `list_trades`

The agent makes markets by looping `wait_for_rfq` → decide a price → `submit_quote`.
Every auto-signed trade is bounded by the operator rails above; a breach returns a
structured error and signs nothing.

## Development

Tests are [vitest](https://vitest.dev):

```sh
npm install
npm run typecheck && npm test
npm run build            # compiles src/ → dist/, what npm publishes
```

The integration suite drives a full maker+taker cycle against a live desk and
needs one running at `RFQ_BASE_URL`:

```sh
RFQ_BASE_URL=http://localhost:4000 npm run test:integration
```

## License

MIT — see [LICENSE](LICENSE).
