import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { DailyMealsAdapter } from "./adapter.js";
import { DurableObjectStore } from "./idempotency.js";
import { type OAuthPayload, pkce, randomId, seal, unseal } from "./oauth.js";
import { createMcpServer } from "./server.js";

export { IdempotencyCoordinator } from "./idempotency.js";
export interface Env {
  DAILYMEALS_ORIGIN?: string;
  IDEMPOTENCY: DurableObjectNamespace;
  OAUTH_TOKEN_KEY: string;
}

type Client = OAuthPayload & { type: "client"; redirectUris: string[] };
type Code = OAuthPayload & {
  type: "code";
  cookie: string;
  redirectUri: string;
  challenge: string;
  subject: string;
  expiresAt: number;
};
type Access = OAuthPayload & {
  type: "access";
  cookie: string;
  subject: string;
  expiresAt: number;
};

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers":
    "Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID",
  "access-control-expose-headers":
    "MCP-Protocol-Version, MCP-Session-Id, WWW-Authenticate",
};
const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors, ...headers },
  });
const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;");

function authPage(url: URL, message = "") {
  const hidden = [
    "response_type",
    "client_id",
    "redirect_uri",
    "state",
    "code_challenge",
    "code_challenge_method",
  ]
    .map(
      (name) =>
        `<input type="hidden" name="${name}" value="${escapeHtml(url.searchParams.get(name) ?? "")}">`,
    )
    .join("");
  return new Response(
    `<!doctype html><title>Connect DailyMeals</title><main><h1>Connect DailyMeals</h1><p>Paste your DailyMeals Cookie header. It is encrypted into your short-lived OAuth token and is not stored by this service.</p>${message}<form method="post" action="/authorize">${hidden}<textarea name="cookie" required autocomplete="off"></textarea><button>Connect</button></form></main>`,
    { headers: { "content-type": "text/html; charset=utf-8", ...cors } },
  );
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const origin = url.origin;
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors });
    if (url.pathname === "/healthz")
      return json(
        { ok: Boolean(env.OAUTH_TOKEN_KEY) },
        env.OAUTH_TOKEN_KEY ? 200 : 503,
      );
    if (
      url.pathname === "/.well-known/oauth-protected-resource" ||
      url.pathname === "/.well-known/oauth-protected-resource/mcp"
    )
      return json({
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        bearer_methods_supported: ["header"],
      });
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    if (url.pathname === "/register" && request.method === "POST") {
      const body = (await request.json()) as { redirect_uris?: unknown };
      if (
        !Array.isArray(body.redirect_uris) ||
        !body.redirect_uris.every(
          (uri) =>
            typeof uri === "string" && new URL(uri).protocol === "https:",
        )
      )
        return json({ error: "invalid_client_metadata" }, 400);
      return json(
        {
          client_id: await seal(
            { type: "client", redirectUris: body.redirect_uris },
            env.OAUTH_TOKEN_KEY,
          ),
          token_endpoint_auth_method: "none",
        },
        201,
      );
    }
    if (url.pathname === "/authorize" && request.method === "GET")
      return authPage(url);
    if (url.pathname === "/authorize" && request.method === "POST") {
      const data = await request.formData();
      const redirectUri = String(data.get("redirect_uri") ?? "");
      const challenge = String(data.get("code_challenge") ?? "");
      const cookie = String(data.get("cookie") ?? "");
      const client = await unseal<Client>(
        String(data.get("client_id") ?? ""),
        env.OAUTH_TOKEN_KEY,
      );
      if (
        data.get("response_type") !== "code" ||
        data.get("code_challenge_method") !== "S256" ||
        !client ||
        client.type !== "client" ||
        !client.redirectUris.includes(redirectUri) ||
        !challenge ||
        !cookie
      )
        return authPage(url, "<p>Invalid authorization request.</p>");
      try {
        await new DailyMealsAdapter(
          env.DAILYMEALS_ORIGIN ?? "https://dailymeals.rs",
          async () => cookie,
        ).listDeliveries();
      } catch {
        return authPage(url, "<p>DailyMeals rejected that cookie.</p>");
      }
      const code = await seal(
        {
          type: "code",
          cookie,
          redirectUri,
          challenge,
          subject: randomId(),
          expiresAt: Date.now() + 300_000,
        },
        env.OAUTH_TOKEN_KEY,
      );
      const destination = new URL(redirectUri);
      destination.searchParams.set("code", code);
      if (data.get("state"))
        destination.searchParams.set("state", String(data.get("state")));
      return Response.redirect(destination.toString(), 302);
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const data = await request.formData();
      const code = await unseal<Code>(
        String(data.get("code") ?? ""),
        env.OAUTH_TOKEN_KEY,
      );
      const verifier = String(data.get("code_verifier") ?? "");
      if (
        data.get("grant_type") !== "authorization_code" ||
        !code ||
        code.type !== "code" ||
        code.expiresAt < Date.now() ||
        code.redirectUri !== data.get("redirect_uri") ||
        code.challenge !== (await pkce(verifier))
      )
        return json({ error: "invalid_grant" }, 400);
      return json({
        access_token: await seal(
          {
            type: "access",
            cookie: code.cookie,
            subject: code.subject,
            expiresAt: Date.now() + 3_600_000,
          },
          env.OAUTH_TOKEN_KEY,
        ),
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    if (url.pathname !== "/mcp") return json({ error: "not_found" }, 404);
    const bearer = request.headers
      .get("authorization")
      ?.match(/^Bearer\s+(.+)$/i)?.[1];
    const access = bearer
      ? await unseal<Access>(bearer, env.OAUTH_TOKEN_KEY)
      : undefined;
    if (access?.type !== "access" || access.expiresAt < Date.now())
      return json({ error: "Unauthorized" }, 401, {
        "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      });
    const adapter = new DailyMealsAdapter(
      env.DAILYMEALS_ORIGIN ?? "https://dailymeals.rs",
      async () => access.cookie,
    );
    const baseStore = new DurableObjectStore(env.IDEMPOTENCY);
    const store = {
      claim: (key: string) => baseStore.claim(`${access.subject}:${key}`),
      complete: (key: string) => baseStore.complete(`${access.subject}:${key}`),
      release: (key: string) => baseStore.release(`${access.subject}:${key}`),
    };
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await createMcpServer(adapter, store).connect(transport);
    const response = await transport.handleRequest(request);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: { ...Object.fromEntries(response.headers), ...cors },
    });
  },
} satisfies ExportedHandler<Env>;
