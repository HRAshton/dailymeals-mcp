import { DailyMealsError } from "./errors.js";
import {
  parseDeliveriesPage,
  parseOrderConfirmation,
  parseOrderPage,
} from "./parser.js";
import type {
  Delivery,
  DeliveryTimeOption,
  HistoricalOrder,
  OrderItem,
  ParsedOrderPage,
} from "./types.js";

type RequestedItem = { dish_id: number; variant_id: number; quantity: number };
const deliveryTimeFieldNames = new Set([
  "selected_delivery_time_array[]",
  "selected_delivery_time_array",
]);

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

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("text/html")) {
      const html = await response.clone().text();
      if (/<title[^>]*>\s*Требуется вход\s*<\/title>/i.test(html))
        throw new DailyMealsError(
          "DAILYMEALS_AUTH_FAILED",
          "DailyMeals authentication failed.",
        );
    }

    return response;
  }

  private async deliveriesPage(path = "/user-deliveries") {
    const response = await this.request(path);
    return parseDeliveriesPage(await response.text());
  }

  async listDeliveries(): Promise<Delivery[]> {
    return (await this.deliveriesPage()).deliveries;
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
    const orders: HistoricalOrder[] = [];
    const seenDeliveryIds = new Set<number>();
    const candidatePages = new Map<number, string>();
    const visitedPages = new Set<number>([1]);
    let path = "/user-deliveries";

    while (orders.length < limit) {
      const page = await this.deliveriesPage(path);
      for (const paginationPath of page.paginationPaths) {
        const number = pageNumber(paginationPath);
        if (number !== undefined && number > 1 && !visitedPages.has(number))
          candidatePages.set(number, paginationPath);
      }

      for (const delivery of page.deliveries) {
        if (orders.length >= limit) break;
        if (
          seenDeliveryIds.has(delivery.id) ||
          delivery.status !== "Завершена" ||
          !delivery.orderPath.includes("/user-order-confirmation")
        )
          continue;
        seenDeliveryIds.add(delivery.id);
        const items = parseOrderConfirmation(
          await (await this.request(delivery.orderPath)).text(),
        );
        orders.push({
          deliveryId: delivery.id,
          date: delivery.date,
          status: delivery.status,
          items,
          total: items.reduce((sum, item) => sum + item.lineTotal, 0),
        });
      }

      if (orders.length >= limit) break;
      const nextPage = [...candidatePages.keys()]
        .filter((number) => !visitedPages.has(number))
        .sort((a, b) => a - b)[0];
      if (nextPage === undefined || visitedPages.size >= 100) break;
      visitedPages.add(nextPage);
      path = candidatePages.get(nextPage) as string;
      candidatePages.delete(nextPage);
    }

    return orders;
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
          !name.startsWith("dishes[") && !deliveryTimeFieldNames.has(name),
      ),
    );

    const selectedTimes =
      deliveryTime === undefined
        ? page.selectedDeliveryTimes
        : normalizeTime(deliveryTime, page.deliveryTimeOptions);
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
    const body = new FormData();
    for (const [key, values] of fields)
      for (const value of values) body.append(key, value);
    const response = await this.request("/user-order-save", {
      method: "POST",
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

function pageNumber(path: string) {
  try {
    const value = new URL(path, "https://dailymeals.invalid").searchParams.get(
      "page",
    );
    if (!value || !/^\d+$/.test(value)) return undefined;
    return Number(value);
  } catch {
    return undefined;
  }
}

function normalizeTime(value: string, options: DeliveryTimeOption[]) {
  const selected = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (selected.length > 1)
    return selected.map((slot) => requireSlot(slot, options));

  const normalizedValue = normalizeSlot(value.trim(), options);
  if (normalizedValue) return [normalizedValue];

  const match = value.trim().match(/^(\d{1,2})(?::00)?-(\d{1,2})(?::00)?$/);

  if (!match)
    throw new DailyMealsError(
      "INVALID_DELIVERY_TIME",
      "That delivery time is not available.",
    );
  const expanded: string[] = [];

  for (let hour = Number(match[1]); hour < Number(match[2]); hour++) {
    const slot = findMatchingSlot(hour, hour + 1, options);
    if (!slot)
      throw new DailyMealsError(
        "INVALID_DELIVERY_TIME",
        "That delivery time is not available.",
      );
    expanded.push(slot);
  }

  return expanded;
}

function requireSlot(value: string, options: DeliveryTimeOption[]) {
  const slot = normalizeSlot(value, options);
  if (!slot)
    throw new DailyMealsError(
      "INVALID_DELIVERY_TIME",
      "That delivery time is not available.",
    );
  return slot;
}

function normalizeSlot(value: string, options: DeliveryTimeOption[]) {
  const exact = options.find(
    (option) => option.value === value || option.label === value,
  );
  if (exact) return exact.value;
  const match = value.match(/^(\d{1,2})(?::00)?-(\d{1,2})(?::00)?$/);
  return match
    ? findMatchingSlot(Number(match[1]), Number(match[2]), options)
    : undefined;
}

function findMatchingSlot(
  start: number,
  end: number,
  options: DeliveryTimeOption[],
) {
  const candidates = [
    `${start}:00-${end}:00`,
    `${String(start).padStart(2, "0")}:00-${String(end).padStart(2, "0")}:00`,
    `${start}-${end}`,
    `${String(start).padStart(2, "0")}-${String(end).padStart(2, "0")}`,
  ];
  return options.find(
    (option) =>
      candidates.includes(option.value) || candidates.includes(option.label),
  )?.value;
}
