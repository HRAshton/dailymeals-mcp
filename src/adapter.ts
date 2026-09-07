import { DailyMealsError } from "./errors.js";
import {
  parseDeliveries,
  parseOrderConfirmation,
  parseOrderPage,
} from "./parser.js";
import type {
  Delivery,
  HistoricalOrder,
  OrderItem,
  ParsedOrderPage,
} from "./types.js";

type RequestedItem = { dish_id: number; variant_id: number; quantity: number };
export class DailyMealsAdapter {
  constructor(
    private readonly origin: string,
    private readonly cookie: () => Promise<string>,
  ) {}

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const cookie = await this.cookie();
    if (!cookie)
      throw new DailyMealsError(
        "DAILYMEALS_AUTH_MISSING",
        "DailyMeals credential is not configured.",
      );

    const response = await fetch(new URL(path, this.origin), {
      ...init,
      redirect: "manual",
      headers: {
        Cookie: cookie,
        Accept: "text/html, application/json",
        ...(init?.headers ?? {}),
      },
    });

    if (
      response.status === 401 ||
      response.status === 403 ||
      response.status === 302
    )
      throw new DailyMealsError(
        "DAILYMEALS_AUTH_FAILED",
        "DailyMeals authentication failed.",
      );

    if (!response.ok)
      throw new DailyMealsError(
        "DAILYMEALS_UPSTREAM_ERROR",
        `DailyMeals returned HTTP ${response.status}.`,
      );
    return response;
  }

  async listDeliveries(): Promise<Delivery[]> {
    return parseDeliveries(
      await (await this.request("/user-deliveries")).text(),
    );
  }

  async loadOrder(deliveryId: number): Promise<ParsedOrderPage> {
    const deliveries = await this.listDeliveries();
    const delivery = deliveries.find((d) => d.id === deliveryId && d.editable);
    if (!delivery)
      throw new DailyMealsError(
        "INVALID_DELIVERY",
        "That delivery is not editable by this account.",
      );
    return parseOrderPage(
      await (await this.request(delivery.orderPath)).text(),
      deliveryId,
    );
  }

  async listRecentOrders(limit: number): Promise<HistoricalOrder[]> {
    const deliveries = (await this.listDeliveries())
      .filter((delivery) => !delivery.editable)
      .slice(0, limit);
    return Promise.all(
      deliveries.map(async (delivery) => {
        const items = parseOrderConfirmation(
          await (await this.request(delivery.orderPath)).text(),
        );
        return {
          deliveryId: delivery.id,
          date: delivery.date,
          status: delivery.status,
          items,
          total: items.reduce((sum, item) => sum + item.lineTotal, 0),
        };
      }),
    );
  }

  prepare(
    page: ParsedOrderPage,
    requested: RequestedItem[],
    deliveryTime?: string,
    comment?: string,
  ) {
    if (!page.canOrder)
      throw new DailyMealsError(
        "ORDER_CUTOFF_PASSED",
        "DailyMeals is no longer accepting this order.",
      );
    const fields = new Map(
      [...page.form].filter(
        ([name]) =>
          !name.startsWith("dishes[") &&
          name !== "selected_delivery_time_array[]",
      ),
    );

    const selectedTimes =
      deliveryTime === undefined
        ? page.selectedDeliveryTimes
        : normalizeTime(deliveryTime, page.deliveryTimes);
    fields.set("selected_delivery_time_array[]", selectedTimes);

    if (comment !== undefined) fields.set("comment", [comment]);

    const items: OrderItem[] = requested.map((request) => {
      if (!Number.isInteger(request.quantity) || request.quantity < 1)
        throw new DailyMealsError(
          "INVALID_QUANTITY",
          "Item quantity must be a positive integer.",
        );
      const dish = page.dishes.find((d) => d.id === request.dish_id);
      if (!dish || request.quantity > dish.availableQuantity)
        throw new DailyMealsError(
          "UNAVAILABLE_DISH",
          "A requested dish is unavailable in that quantity.",
        );
      const variant = dish.variants.length
        ? dish.variants.find((v) => v.id === request.variant_id)
        : request.variant_id === 0
          ? { id: 0, name: "" }
          : undefined;
      if (!variant)
        throw new DailyMealsError(
          "INVALID_VARIANT",
          "A requested dish variant is unavailable.",
        );

      return {
        dishId: dish.id,
        variantId: variant.id,
        revision: dish.revision,
        name: dish.name,
        variantName: variant.name,
        quantity: request.quantity,
        unitPrice: dish.price,
        lineTotal: dish.price * request.quantity,
      };
    });

    for (const item of items) {
      const base = `dishes[dish-${item.dishId} variant-${item.variantId}]`;
      fields.set(`${base}[dish_name]`, [item.name]);
      fields.set(`${base}[variant_name]`, [item.variantName]);
      fields.set(`${base}[quantity]`, [String(item.quantity)]);
      fields.set(`${base}[price]`, [String(item.lineTotal)]);
      fields.set(`${base}[dish_id]`, [String(item.dishId)]);
      fields.set(`${base}[dish_revision]`, [String(item.revision)]);
      fields.set(`${base}[dish_variant_id]`, [String(item.variantId)]);
      fields.set(`${base}[dish_price]`, [String(item.unitPrice)]);
    }

    return {
      fields,
      items,
      total: items.reduce((total, item) => total + item.lineTotal, 0),
      selectedTimes,
    };
  }

  async submit(fields: Map<string, string[]>): Promise<unknown> {
    const body = new URLSearchParams();
    for (const [key, values] of fields)
      for (const value of values) body.append(key, value);
    const response = await this.request("/user-order-save", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const result = (await response.json().catch(() => {
      throw new DailyMealsError(
        "DAILYMEALS_UPSTREAM_ERROR",
        "DailyMeals returned an invalid save response.",
      );
    })) as { success?: unknown; message?: unknown };

    if (!result?.success)
      throw new DailyMealsError(
        "DAILYMEALS_REJECTED",
        typeof result?.message === "string"
          ? result.message
          : "DailyMeals rejected the order.",
      );

    return {
      success: true,
      message: typeof result.message === "string" ? result.message : undefined,
    };
  }
}

function normalizeTime(value: string, options: string[]) {
  if (options.includes(value)) return [value];
  const match = value.match(/^(\d{1,2}):00-(\d{1,2}):00$/);

  if (!match)
    throw new DailyMealsError(
      "INVALID_DELIVERY_TIME",
      "That delivery time is not available.",
    );
  const selected: string[] = [];

  for (let hour = Number(match[1]); hour < Number(match[2]); hour++) {
    const slot = `${hour}:00-${hour + 1}:00`;
    if (!options.includes(slot))
      throw new DailyMealsError(
        "INVALID_DELIVERY_TIME",
        "That delivery time is not available.",
      );
    selected.push(slot);
  }

  return selected;
}
