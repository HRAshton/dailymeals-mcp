# DailyMeals MCP

A private Streamable HTTP MCP server for one DailyMeals account, deployed as a
Cloudflare Worker. It reads live order data using a scoped cookie and submits
only the exact form data supplied by DailyMeals.

## Safety model

- `/mcp` requires `Authorization: Bearer $MCP_AUTH_TOKEN`; it is never public.
- `DAILYMEALS_COOKIE` and `MCP_AUTH_TOKEN` are Worker secrets and are never
  returned in tool output.
- Each idempotency key is owned by a Cloudflare Durable Object. Its serialized
  storage makes claiming a key atomic across Worker instances.
- Drafts only read and validate. Submissions require `confirmation: true`, a
  new durable idempotency key, ownership/menu reload, and a final live reload
  immediately before the upstream write. A key is retained after a write starts
  because the upstream outcome may be unknown.

## Local development

```sh
npm install
npm test
npm run dev
```

Create `.dev.vars` locally (it is gitignored):

```ini
DAILYMEALS_COOKIE=...
MCP_AUTH_TOKEN=...
DAILYMEALS_ORIGIN=https://dailymeals.rs
```

The Worker runs at `http://localhost:8787`; connect an MCP client to
`http://localhost:8787/mcp` with the bearer token. `GET /healthz` only reports
whether both required secrets are configured.

## Deploy to Cloudflare

Authenticate Wrangler, set the two secrets, then deploy. The first deployment
creates the Durable Object through the `v1` migration in `wrangler.jsonc`.

```sh
npx wrangler login
npx wrangler secret put DAILYMEALS_COOKIE
npx wrangler secret put MCP_AUTH_TOKEN
npm run deploy
```

`DAILYMEALS_ORIGIN` defaults to `https://dailymeals.rs`; set it as a Worker
variable only when using a non-production endpoint. Keep the Worker URL private
to the intended MCP client and retain the bearer-token check as the application
authorization boundary.
