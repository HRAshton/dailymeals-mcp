import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { DailyMealsAdapter } from "./adapter.js";
import { DurableObjectStore } from "./idempotency.js";
import { createMcpServer } from "./server.js";

export { IdempotencyCoordinator } from "./idempotency.js";

export interface Env {
  DAILYMEALS_COOKIE: string;
  DAILYMEALS_ORIGIN?: string;
  IDEMPOTENCY: DurableObjectNamespace;
  MCP_AUTH_TOKEN: string;
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

async function secureEquals(actual: string, expected: string) {
  const encoder = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all(
    [actual, expected].map((value) =>
      crypto.subtle.digest("SHA-256", encoder.encode(value)),
    ),
  );
  const actualBytes = new Uint8Array(actualHash);
  const expectedBytes = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < actualBytes.length; index++)
    difference |= actualBytes[index] ^ expectedBytes[index];
  return difference === 0;
}

async function isAuthorized(request: Request, expectedToken: string) {
  const supplied = request.headers
    .get("authorization")
    ?.match(/^Bearer\s+(.+)$/i)?.[1];
  return Boolean(supplied && (await secureEquals(supplied, expectedToken)));
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz")
      return json(
        { ok: Boolean(env.DAILYMEALS_COOKIE && env.MCP_AUTH_TOKEN) },
        env.DAILYMEALS_COOKIE && env.MCP_AUTH_TOKEN ? 200 : 503,
      );

    if (url.pathname !== "/mcp")
      return new Response("Not Found", { status: 404 });
    if (!(await isAuthorized(request, env.MCP_AUTH_TOKEN)))
      return json({ error: "Unauthorized" }, 401);

    const adapter = new DailyMealsAdapter(
      env.DAILYMEALS_ORIGIN ?? "https://dailymeals.rs",
      async () => env.DAILYMEALS_COOKIE,
    );
    const server = createMcpServer(
      adapter,
      new DurableObjectStore(env.IDEMPOTENCY),
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
} satisfies ExportedHandler<Env>;
