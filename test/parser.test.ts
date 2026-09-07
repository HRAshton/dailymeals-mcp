import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DailyMealsAdapter } from "../src/adapter.js";
import { DailyMealsError } from "../src/errors.js";
import { IdempotencyCoordinator } from "../src/idempotency.js";
import { parseOrderPage } from "../src/parser.js";

const fixture = await readFile(
  new URL("./fixtures/order-page.html", import.meta.url),
  "utf8",
);
test("parses menu, revisions, current order, and preserved profile fields", () => {
  const page = parseOrderPage(fixture, 714);
  assert.deepEqual(
    page.dishes.map((d) => [d.id, d.revision, d.availableQuantity]),
    [
      [1, 3, 2],
      [9, 4, 1],
    ],
  );
  assert.equal(page.currentItems[0].lineTotal, 150);
  assert.equal(page.form.get("address")?.[0], "REDACTED");
});
test("draft replaces requested zero/old items, expands time slots, and recalculates from live price", () => {
  const adapter = new DailyMealsAdapter(
    "https://example.test",
    async () => "cookie",
  );
  const draft = adapter.prepare(
    parseOrderPage(fixture, 714),
    [{ dish_id: 9, variant_id: 0, quantity: 1 }],
    "9:00-11:00",
    "note",
  );
  assert.equal(draft.total, 200);
  assert.deepEqual(draft.selectedTimes, ["9:00-10:00", "10:00-11:00"]);
  assert.equal(draft.fields.get("address")?.[0], "REDACTED");
  assert.equal(draft.fields.get("comment")?.[0], "note");
  assert.equal(
    [...draft.fields.keys()].some((k) => k.includes("dish-1")),
    false,
  );
});
test("rejects unavailable variants, quantities, and delivery times", () => {
  const adapter = new DailyMealsAdapter(
    "https://example.test",
    async () => "cookie",
  );
  const page = parseOrderPage(fixture, 714);
  assert.throws(
    () => adapter.prepare(page, [{ dish_id: 9, variant_id: 0, quantity: 2 }]),
    DailyMealsError,
  );
  assert.throws(
    () => adapter.prepare(page, [{ dish_id: 9, variant_id: 9, quantity: 1 }]),
    DailyMealsError,
  );
  assert.throws(
    () =>
      adapter.prepare(
        page,
        [{ dish_id: 9, variant_id: 0, quantity: 1 }],
        "12:00-13:00",
      ),
    DailyMealsError,
  );
});
test("rejects submissions after the live cutoff", () => {
  const closed = parseOrderPage(`${fixture}<p>Заказы не принимаются</p>`, 714);
  const adapter = new DailyMealsAdapter(
    "https://example.test",
    async () => "cookie",
  );
  assert.throws(
    () => adapter.prepare(closed, [{ dish_id: 9, variant_id: 0, quantity: 1 }]),
    (error: unknown) =>
      error instanceof DailyMealsError && error.code === "ORDER_CUTOFF_PASSED",
  );
});
test("rejects wrong delivery and malformed HTML", () => {
  assert.throws(() => parseOrderPage(fixture, 999), DailyMealsError);
  assert.throws(() => parseOrderPage("<html></html>", 714), DailyMealsError);
});
test("fails closed when DailyMeals authentication is absent", async () => {
  const adapter = new DailyMealsAdapter("https://example.test", async () => "");
  await assert.rejects(
    () => adapter.listDeliveries(),
    (error: unknown) =>
      error instanceof DailyMealsError &&
      error.code === "DAILYMEALS_AUTH_MISSING",
  );
});
test("rejects deliveries not owned by the authenticated account", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      '<a href="/user-order?delivery_id=3&user_id=REDACTED">Order</a>',
    );
  try {
    const adapter = new DailyMealsAdapter(
      "https://example.test",
      async () => "cookie",
    );
    await assert.rejects(
      () => adapter.loadOrder(714),
      (error: unknown) =>
        error instanceof DailyMealsError && error.code === "INVALID_DELIVERY",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("durably retains claimed idempotency keys", async () => {
  const records = new Map<string, string>();
  const storage = {
    get: async (key: string) => records.get(key),
    put: async (key: string, value: string) => records.set(key, value),
    delete: async (key: string) => records.delete(key),
  };
  const coordinator = new IdempotencyCoordinator({
    storage,
  } as unknown as DurableObjectState);
  const claim = () =>
    coordinator.fetch(
      new Request("https://idempotency/claim", { method: "POST" }),
    );

  assert.equal((await claim()).status, 204);
  assert.equal((await claim()).status, 409);
  assert.equal(
    (
      await coordinator.fetch(
        new Request("https://idempotency/release", { method: "POST" }),
      )
    ).status,
    204,
  );
  assert.equal((await claim()).status, 204);
});
test("surfaces a DailyMeals save rejection without exposing a payload", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ success: false, message: "Closed" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  try {
    const adapter = new DailyMealsAdapter(
      "https://example.test",
      async () => "cookie",
    );
    await assert.rejects(
      () => adapter.submit(new Map([["address", ["REDACTED"]]])),
      (error: unknown) =>
        error instanceof DailyMealsError &&
        error.code === "DAILYMEALS_REJECTED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
