# DailyMeals MCP

A private Streamable HTTP MCP server for one DailyMeals account. It reads the live site with a scoped cookie and uses the exact dynamic order form supplied by DailyMeals. It never returns the cookie, profile fields, address, or raw HTML.

## Safety model

- `/mcp` requires `Authorization: Bearer $MCP_AUTH_TOKEN`; it is not an anonymous endpoint.
- `DAILYMEALS_COOKIE` is loaded from an environment secret, or `DAILYMEALS_COOKIE_FILE` is reread for every site request. Mount the latter from Secret Manager's `latest` version for rotation without application code changes; Cloud Run's refresh timing is platform-controlled.
- Drafts only fetch and validate. Submissions require schema-level `confirmation: true`, a new durable idempotency key, a fresh ownership/menu reload, and live form data. An uncertain upstream write retains its key to prevent retries creating a duplicate.
- No cancellation tool is exposed: it is intentionally deferred until read/submit flows have been validated.

## Local setup

```sh
cp .env.example .env
npm install
npm test
npm run build
```

Set secrets in your shell or secret manager; never put them in `.env.example` or source control. Local submission testing may set `IDEMPOTENCY_BACKEND=memory`; production requires `FIRESTORE_IDEMPOTENCY_COLLECTION` and Application Default Credentials.

Run `npm run dev`, then connect an MCP client to `http://localhost:8080/mcp` with the bearer token. `GET /healthz` reports only credential configuration state.

## Cloud Run

Create a Firestore database and an idempotency collection, then build and deploy the container. Give the Cloud Run service account Firestore access. Store the DailyMeals cookie and MCP bearer token as separate Secret Manager secrets. Mount the cookie secret as a volume (for example `/var/secrets/dailymeals/cookie`) rather than an env variable if rotation without a revision deployment is required.

```sh
gcloud run deploy dailymeals-mcp --source . --region REGION \
  --set-env-vars DAILYMEALS_ORIGIN=https://dailymeals.rs,FIRESTORE_IDEMPOTENCY_COLLECTION=dailymeals-mcp-idempotency,DAILYMEALS_COOKIE_FILE=/var/secrets/dailymeals/cookie \
  --update-secrets MCP_AUTH_TOKEN=mcp-auth-token:latest \
  --add-volume name=dailymeals-cookie,type=secret,secret=dailymeals-cookie \
  --add-volume-mount volume=dailymeals-cookie,mount-path=/var/secrets/dailymeals
```

Restrict ingress and put an OpenAI-managed mTLS-capable gateway in front when the selected ChatGPT deployment supports it. The application bearer check remains a defense in depth layer. Do not grant public unauthenticated access.

## MCP Inspector

Use an authenticated HTTPS tunnel or deployed URL, then run MCP Inspector with `Authorization: Bearer …`. Verify initialize/tool discovery; call read tools; call `create_order_draft`; verify invalid quantities and times fail; verify `submit_order` without `confirmation: true` is schema-rejected; and only perform an explicitly approved real submission using a fresh idempotency key. Never use Inspector to probe cancellation.

## Private ChatGPT connection

Configure a private connector with URL `https://SERVICE_URL/mcp`, bearer secret `MCP_AUTH_TOKEN`, and OpenAI-managed mTLS enabled where available. The tool metadata labels reads and describes the consequential confirmation requirement for `submit_order`.
