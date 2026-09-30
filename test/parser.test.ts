import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DailyMealsAdapter } from "../src/adapter.js";
import { DailyMealsError } from "../src/errors.js";
import { IdempotencyCoordinator } from "../src/idempotency.js";
import {
  parseDeliveries,
  parseOrderConfirmation,
  parseOrderPage,
} from "../src/parser.js";

const fixture = await readFile(
  new URL("./fixtures/order-page.html", import.meta.url),
  "utf8",
);

const deliveriesTable = (rows: string, pagination = "") => `
  <html><body>
    <table>
      <tr><th>Дата</th><th>Собираем заказы до</th><th>Статус доставки</th><th>Выбранное время доставки</th><th>Действия</th></tr>
      ${rows}
    </table>
    ${pagination}
  </body></html>`;

const deliveryRow = ({
  id,
  date,
  cutoff,
  status,
  time,
  confirmation = false,
}: {
  id: number;
  date: string;
  cutoff: string;
  status: string;
  time: string;
  confirmation?: boolean;
}) => `<tr>
  <td>${date}</td><td>${cutoff}</td><td>${status}</td><td>${time}</td>
  <td><a href="/${confirmation ? "user-order-confirmation" : "user-order"}?delivery_id=${id}&user_id=445">Open</a></td>
</tr>`;

const confirmation = (name: string, total: number) => `
  <table><tr><th>Блюдо</th><th>Вариант</th><th>Количество</th><th>Стоимость</th></tr>
  <tr><td>${name}</td><td></td><td>1</td><td>${total} RSD</td></tr></table>`;

test("parses structured delivery columns instead of copying the whole row", () => {
  const [delivery] = parseDeliveries(
    deliveriesTable(
      deliveryRow({
        id: 737,
        date: "3 октября 2026 (суббота)",
        cutoff: "11:00, 2 октября (пятница)",
        status: "Принимаем заказы",
        time: "9:00-11:00",
      }),
    ),
  );
  assert.deepEqual(delivery, {
    id: 737,
    date: "3 октября 2026 (суббота)",
    cutoff: "11:00, 2 октября (пятница)",
    status: "Принимаем заказы",
    deliveryTime: "9:00-11:00",
    editable: true,
    orderPath: "/user-order?delivery_id=737&user_id=445",
  });
});

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

test("uses hidden original price and multiplier and the hidden variant ID", () => {
  const page = parseOrderPage(fixture, 714);
  assert.equal(page.dishes[1].price, 200);
  assert.equal(page.dishes[0].variants[0].id, 2);
});

test("parses completed orders without profile fields", () => {
  const items = parseOrderConfirmation(confirmation("Soup", 300));
  assert.deepEqual(items, [
    { name: "Soup", variantName: "", quantity: 1, lineTotal: 300 },
  ]);
});

test("draft replaces requested zero/old items, expands labeled time slots, and recalculates from live price", () => {
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
  assert.deepEqual(draft.selectedTimes, ["9", "10"]);
  assert.equal(draft.fields.get("address")?.[0], "REDACTED");
  assert.equal(draft.fields.get("comment")?.[0], "note");
  assert.equal(
    [...draft.fields.keys()].some((k) => k.includes("dish-1")),
    false,
  );
});

test("draft accepts short comma-separated delivery slot labels", () => {
  const adapter = new DailyMealsAdapter(
    "https://example.test",
    async () => "cookie",
  );
  const draft = adapter.prepare(
    parseOrderPage(fixture, 714),
    [{ dish_id: 9, variant_id: 0, quantity: 1 }],
    "9-10,10-11",
  );
  assert.deepEqual(draft.selectedTimes, ["9", "10"]);
});

test("parses delivery time fields without bracket suffix", () => {
  const page = parseOrderPage(
    fixture.replaceAll(
      "selected_delivery_time_array[]",
      "selected_delivery_time_array",
    ),
    714,
  );
  assert.deepEqual(page.deliveryTimes, ["9", "10"]);
  assert.deepEqual(page.selectedDeliveryTimes, ["9", "10"]);
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

test("treats HTTP 200 login-required HTML as an authentication failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("<html><title>Требуется вход</title></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=UTF-8" },
    });
  try {
    const adapter = new DailyMealsAdapter(
      "https://example.test",
      async () => "cookie",
    );
    await assert.rejects(
      () => adapter.listDeliveries(),
      (error: unknown) =>
        error instanceof DailyMealsError &&
        error.code === "DAILYMEALS_AUTH_FAILED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects deliveries not owned by the authenticated account", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      deliveriesTable(
        deliveryRow({
          id: 3,
          date: "date",
          cutoff: "cutoff",
          status: "Принимаем заказы",
          time: "Не выбрано",
        }),
      ),
      { headers: { "content-type": "text/html" } },
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

test("paginates historical deliveries using observed links and skips page zero", async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input.toString());
    requested.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/user-deliveries" && url.searchParams.get("page") === "2")
      return new Response(
        deliveriesTable(
          deliveryRow({
            id: 722,
            date: "older",
            cutoff: "closed",
            status: "Завершена",
            time: "9:00-10:00",
            confirmation: true,
          }),
        ),
        { headers: { "content-type": "text/html" } },
      );
    if (url.pathname === "/user-deliveries")
      return new Response(
        deliveriesTable(
          deliveryRow({
            id: 736,
            date: "newer",
            cutoff: "closed",
            status: "Завершена",
            time: "9:00-11:00",
            confirmation: true,
          }),
          '<a href="/user-deliveries?user_id=445&page=0">0</a><a href="/user-deliveries?user_id=445&page=1">1</a><a href="/user-deliveries?user_id=445&page=2">2</a>',
        ),
        { headers: { "content-type": "text/html" } },
      );
    if (url.pathname === "/user-order-confirmation")
      return new Response(
        confirmation(url.searchParams.get("delivery_id") ?? "dish", 100),
        { headers: { "content-type": "text/html" } },
      );
    throw new Error(`Unexpected request ${url}`);
  };
  try {
    const adapter = new DailyMealsAdapter(
      "https://example.test",
      async () => "cookie",
    );
    const orders = await adapter.listRecentOrders(2);
    assert.deepEqual(
      orders.map((order) => order.deliveryId),
      [736, 722],
    );
    assert.equal(requested.some((path) => path.includes("page=0")), false);
    assert.equal(requested.some((path) => path.includes("page=2")), true);
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

test("submits the exact fields as browser-style multipart form data", async () => {
  const originalFetch = globalThis.fetch;
  let captured: RequestInit | undefined;
  globalThis.fetch = async (_input, init) => {
    captured = init;
    return new Response(JSON.stringify({ success: true, message: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const adapter = new DailyMealsAdapter(
      "https://example.test",
      async () => "cookie",
    );
    await adapter.submit(
      new Map([
        ["address", ["REDACTED"]],
        ["selected_delivery_time_array[]", ["9", "10"]],
      ]),
    );
    assert.ok(captured?.body instanceof FormData);
    assert.equal(
      new Headers(captured?.headers).has("content-type"),
      false,
    );
    assert.deepEqual(
      (captured?.body as FormData).getAll("selected_delivery_time_array[]"),
      ["9", "10"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
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
