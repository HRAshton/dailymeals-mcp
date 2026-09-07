import assert from "node:assert/strict";
import test from "node:test";
import worker, { type Env } from "../src/worker.js";

const env = {
  DAILYMEALS_COOKIE: "cookie",
  MCP_AUTH_TOKEN: "token",
} as Env;

test("allows MCP Inspector's CORS preflight without bypassing authorization", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/mcp", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:6274",
        "Access-Control-Request-Headers": "authorization, content-type",
        "Access-Control-Request-Method": "POST",
      },
    }),
    env,
  );

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.match(
    response.headers.get("access-control-allow-headers") ?? "",
    /authorization/i,
  );
});

test("keeps MCP requests unauthorized without a bearer token", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/mcp", { method: "POST" }),
    env,
  );

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});
