import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DailyMealsAdapter } from "./adapter.js";
import { DailyMealsError } from "./errors.js";
import type { IdempotencyStore } from "./idempotency.js";

const itemSchema = z.object({
  dish_id: z.number().int().positive(),
  variant_id: z.number().int().nonnegative(),
  quantity: z.number().int().positive(),
});

const orderSchema = z.object({
  delivery_id: z.number().int().positive(),
  items: z.array(itemSchema),
  delivery_time: z.string().min(1),
  comment: z.string().max(1000).optional(),
});

function response(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function safeError(error: unknown) {
  const known =
    error instanceof DailyMealsError
      ? error
      : new DailyMealsError(
          "INTERNAL_ERROR",
          "The request could not be completed.",
        );
  return response({
    ok: false,
    error: { code: known.code, message: known.message },
  });
}

export function createMcpServer(
  adapter: DailyMealsAdapter,
  store: IdempotencyStore,
) {
  const server = new McpServer({ name: "dailymeals", version: "0.1.0" });
  server.registerTool(
    "list_deliveries",
    {
      description:
        "Read upcoming and previous deliveries for the authenticated DailyMeals account.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const deliveries = (await adapter.listDeliveries()).map(
          ({ orderPath: _privatePath, ...delivery }) => delivery,
        );
        return response({ ok: true, deliveries });
      } catch (error) {
        return safeError(error);
      }
    },
  );
  server.registerTool(
    "get_delivery_menu",
    {
      description:
        "Read the live dishes, variants, revisions, prices, and available quantities for an editable delivery.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ delivery_id: z.number().int().positive() }),
    },
    async ({ delivery_id }) => {
      try {
        const page = await adapter.loadOrder(delivery_id);
        return response({
          ok: true,
          delivery_id,
          dishes: page.dishes,
          delivery_times: page.deliveryTimes,
        });
      } catch (error) {
        return safeError(error);
      }
    },
  );
  server.registerTool(
    "get_current_order",
    {
      description:
        "Read the authenticated account's current order and authoritative total for an editable delivery.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ delivery_id: z.number().int().positive() }),
    },
    async ({ delivery_id }) => {
      try {
        const page = await adapter.loadOrder(delivery_id);
        return response({
          ok: true,
          delivery_id,
          items: page.currentItems,
          total: page.total,
          delivery_times: page.selectedDeliveryTimes,
        });
      } catch (error) {
        return safeError(error);
      }
    },
  );

  server.registerTool(
    "create_order_draft",
    {
      description:
        "Validate an intended order against the live menu and return a non-submitted draft. This never changes DailyMeals.",
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: orderSchema,
    },
    async (input) => {
      try {
        const page = await adapter.loadOrder(input.delivery_id);
        const draft = adapter.prepare(
          page,
          input.items,
          input.delivery_time,
          input.comment,
        );
        return response({
          ok: true,
          delivery_id: input.delivery_id,
          items: draft.items,
          total: draft.total,
          delivery_times: draft.selectedTimes,
          submitted: false,
        });
      } catch (error) {
        return safeError(error);
      }
    },
  );

  server.registerTool(
    "submit_order",
    {
      description:
        "Consequentially submit an order to DailyMeals. Only use after the user explicitly confirms the exact order; confirmation must be true and the idempotency key must be new.",
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: orderSchema.extend({
        confirmation: z.literal(true),
        idempotency_key: z.string().min(16).max(200),
      }),
    },

    async (input) => {
      try {
        // Validate before reserving a key, then reload immediately before the write.
        adapter.prepare(
          await adapter.loadOrder(input.delivery_id),
          input.items,
          input.delivery_time,
          input.comment,
        );
        await store.claim(input.idempotency_key);
        let attemptedSubmission = false;
        try {
          const page = await adapter.loadOrder(input.delivery_id); // mandatory immediately-before-submit refresh
          const order = adapter.prepare(
            page,
            input.items,
            input.delivery_time,
            input.comment,
          );
          attemptedSubmission = true;
          const result = await adapter.submit(order.fields);
          await store.complete(input.idempotency_key);
          return response({
            ok: true,
            delivery_id: input.delivery_id,
            items: order.items,
            total: order.total,
            result,
          });
        } catch (error) {
          // Once the request has started, its outcome may be unknown; retaining the key prevents a duplicate.
          if (!attemptedSubmission) await store.release(input.idempotency_key);
          throw error;
        }
      } catch (error) {
        return safeError(error);
      }
    },
  );
  return server;
}
