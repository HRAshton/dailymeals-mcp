import * as cheerio from "cheerio";
import { DailyMealsError } from "./errors.js";
import type {
  Delivery,
  Dish,
  HistoricalOrderItem,
  ParsedOrderPage,
} from "./types.js";

const integer = (value: string | undefined, label: string) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new DailyMealsError(
      "MALFORMED_SITE_HTML",
      `DailyMeals page has an invalid ${label}.`,
    );
  return number;
};

const price = (value: string) => {
  const normalized = value.replace(/[^0-9,.-]/g, "").replace(",", ".");
  if (!/[0-9]/.test(normalized)) return Number.NaN;
  return Number(normalized);
};

const normalizeText = (value: string) => value.replace(/\s+/g, " ").trim();
const deliveryTimeNames = new Set([
  "selected_delivery_time_array[]",
  "selected_delivery_time_array",
]);
const topLevelOrderFields = [
  "delivery_id",
  "user_id",
  "comment",
  "name",
  "telegram",
  "address",
  "selected_delivery_time_array[]",
  "selected_delivery_time_array",
  "save_delivery_data_as_default",
];
const requiredTopLevelOrderFields = [
  "delivery_id",
  "user_id",
  "name",
  "telegram",
  "address",
];

const unique = (values: string[]) => [...new Set(values)];

export type ParsedDeliveriesPage = {
  deliveries: Delivery[];
  paginationPaths: string[];
};

export function parseDeliveries(html: string): Delivery[] {
  return parseDeliveriesPage(html).deliveries;
}

export function parseDeliveriesPage(html: string): ParsedDeliveriesPage {
  const $ = cheerio.load(html);
  const seen = new Set<number>();
  const result: Delivery[] = [];
  const deliveryTables = $("table").filter((_, element) => {
    const headers = $(element)
      .find("tr")
      .first()
      .find("th")
      .map((__, header) => normalizeText($(header).text()))
      .get();
    return (
      headers[0] === "Дата" &&
      headers[1] === "Собираем заказы до" &&
      headers[2] === "Статус доставки" &&
      headers[3] === "Выбранное время доставки" &&
      headers[4] === "Действия"
    );
  });

  if (!deliveryTables.length)
    throw new DailyMealsError(
      "MALFORMED_SITE_HTML",
      "DailyMeals deliveries table was not found.",
    );

  deliveryTables.find("tr").each((_, element) => {
    const row = $(element);
    const cells = row.find("td");
    if (cells.length < 5) return;

    const href = cells
      .eq(4)
      .find("a[href*='user-order']")
      .map((__, anchor) => $(anchor).attr("href") ?? "")
      .get()
      .find(
        (candidate) =>
          candidate.includes("delivery_id=") &&
          !candidate.includes("user-order-save"),
      );
    if (!href) return;

    const match = href.match(/[?&]delivery_id=(\d+)/);
    if (!match) return;
    const id = integer(match[1], "delivery ID");
    if (seen.has(id)) return;
    seen.add(id);

    result.push({
      id,
      date: normalizeText(cells.eq(0).text()),
      cutoff: normalizeText(cells.eq(1).text()),
      status: normalizeText(cells.eq(2).text()),
      deliveryTime: normalizeText(cells.eq(3).text()),
      editable: /\/user-order\?/.test(href),
      orderPath: href,
    });
  });

  const paginationPaths = unique(
    $("a[href*='user-deliveries']")
      .map((_, element) => $(element).attr("href") ?? "")
      .get()
      .flatMap((href) => {
        if (!href) return [];
        try {
          const url = new URL(href, "https://dailymeals.invalid");
          if (url.pathname !== "/user-deliveries") return [];
          const page = url.searchParams.get("page");
          if (!page || !/^\d+$/.test(page)) return [];
          return [`${url.pathname}${url.search}`];
        } catch {
          return [];
        }
      }),
  );

  return { deliveries: result, paginationPaths };
}

export function parseOrderPage(
  html: string,
  expectedDeliveryId: number,
): ParsedOrderPage {
  const $ = cheerio.load(html);
  const formElement = $("#user-order-form");
  if (!formElement.length)
    throw new DailyMealsError(
      "MALFORMED_SITE_HTML",
      "DailyMeals order form was not found.",
    );

  const form = new Map<string, string[]>();
  formElement.find("input, textarea, select").each((_, element) => {
    const input = $(element);
    const name = input.attr("name");
    if (!name || input.is(":disabled") || isMenuCardControl(name)) return;
    addSuccessfulControl(form, input, name);
  });

  // The live browser form contains these fields even when detached HTML parsing
  // does not preserve their form ownership. Re-read the documented top-level
  // controls globally and let those values override detached-parser results.
  for (const name of topLevelOrderFields) {
    const values: string[] = [];
    $("[name]")
      .filter((_, element) => $(element).attr("name") === name)
      .each((_, element) => {
        const control = $(element);
        collectSuccessfulControlValues(control, values);
      });
    if (values.length) form.set(name, values);
    else form.delete(name);
  }

  for (const name of requiredTopLevelOrderFields) {
    if (!form.has(name))
      throw new DailyMealsError(
        "MALFORMED_SITE_HTML",
        `DailyMeals order form is missing ${name}.`,
      );
  }

  const formDeliveryId = integer(form.get("delivery_id")?.[0], "delivery ID");
  if (formDeliveryId !== expectedDeliveryId)
    throw new DailyMealsError(
      "INVALID_DELIVERY",
      "The returned order page belongs to another delivery.",
    );

  const deliveryTimeOptions = readDeliveryTimeOptions($);
  const deliveryTimes = unique(deliveryTimeOptions.map((option) => option.value));
  const selectedDeliveryTimes = [
    ...(form.get("selected_delivery_time_array[]") ?? []),
    ...(form.get("selected_delivery_time_array") ?? []),
  ];

  const dishes: Dish[] = [];
  $(".card").each((_, element) => {
    const card = $(element);
    const idText = card.find("input[name='dish_id']").first().val()?.toString();
    if (!idText) return;
    const id = integer(idText, "dish ID");
    const revision = integer(
      card.find("input[name='dish_revision']").first().val()?.toString(),
      "dish revision",
    );
    const name = normalizeText(
      readTextOrValue(card, "#for_modal_dish_name") ||
        card.find(".card-title").first().text(),
    );
    const originalPrice = price(
      readTextOrValue(card, "#for_modal_dish_price_original"),
    );
    const priceMultiplier = price(
      readTextOrValue(card, "#for_modal_dish_price_multiplier"),
    );
    const unitPrice = Math.round(originalPrice * priceMultiplier);

    const quantityValues = card
      .find("select[name]")
      .filter((__, select) =>
        /^dish_order\[[^\]]+\]\[quantity\]$/.test(
          $(select).attr("name") ?? "",
        ),
      )
      .first()
      .find("option")
      .map((__, option) => Number($(option).attr("value") ?? $(option).text()))
      .get()
      .filter((value) => Number.isSafeInteger(value) && value > 0);
    const availableQuantity = quantityValues.length
      ? Math.max(...quantityValues)
      : 0;

    if (!name || !Number.isFinite(unitPrice))
      throw new DailyMealsError(
        "MALFORMED_SITE_HTML",
        "DailyMeals dish data is incomplete.",
      );

    const variants = card
      .find("input[type='radio'][name]")
      .filter((__, radio) =>
        /^dish_order\[[^\]]+\]\[dish_variant_id\]$/.test(
          $(radio).attr("name") ?? "",
        ),
      )
      .map((__, radio) => {
        const r = $(radio);
        const variantId = r
          .prev("input[name='dish_variant_id']")
          .val()
          ?.toString();
        return {
          id: integer(variantId, "variant ID"),
          name: normalizeText(r.next("label").text()),
        };
      })
      .get();

    dishes.push({
      id,
      revision,
      name,
      price: unitPrice,
      availableQuantity,
      variants,
    });
  });
  if (!dishes.length)
    throw new DailyMealsError(
      "MALFORMED_SITE_HTML",
      "DailyMeals menu contains no dishes.",
    );

  const items = new Map<string, Record<string, string>>();
  $("input[name^='dishes[']").each((_, element) => {
    const input = $(element);
    const name = input.attr("name");
    if (!name) return;
    const value = input.val()?.toString() ?? "";
    const key = name.match(/^dishes\[([^\]]+)\]/)?.[1];
    const field = name.match(/\[([^\]]+)\]$/)?.[1];
    if (key && field)
      items.set(key, { ...(items.get(key) ?? {}), [field]: value });
  });

  const currentItems = [...items.values()]
    .map((item) => {
      const quantity = integer(String(item.quantity), "order quantity");
      const unitPrice = price(String(item.dish_price));
      if (!Number.isFinite(unitPrice))
        throw new DailyMealsError(
          "MALFORMED_SITE_HTML",
          "DailyMeals current order price is invalid.",
        );
      return {
        dishId: integer(String(item.dish_id), "dish ID"),
        variantId: integer(String(item.dish_variant_id), "variant ID"),
        revision: integer(String(item.dish_revision), "dish revision"),
        name: String(item.dish_name),
        variantName: String(item.variant_name),
        quantity,
        unitPrice,
        lineTotal: unitPrice * quantity,
      };
    })
    .filter((item) => item.quantity > 0);

  const canOrder = !/заказ(ы)? не принимаются|прием заказов закрыт/i.test(
    $("body").text(),
  );

  return {
    deliveryId: formDeliveryId,
    form,
    deliveryTimes,
    deliveryTimeOptions,
    selectedDeliveryTimes,
    dishes,
    currentItems,
    total: currentItems.reduce((sum, item) => sum + item.lineTotal, 0),
    canOrder,
  };
}

export function parseOrderConfirmation(html: string): HistoricalOrderItem[] {
  const $ = cheerio.load(html);
  const table = $("table").filter((_, element) => {
    const headers = $(element)
      .find("th")
      .map((__, header) => $(header).text().trim())
      .get();
    return headers.join("|") === "Блюдо|Вариант|Количество|Стоимость";
  });
  if (!table.length)
    throw new DailyMealsError(
      "MALFORMED_SITE_HTML",
      "DailyMeals completed order was not found.",
    );

  const items = table
    .find("tr")
    .map((_, row) => {
      const cells = $(row).find("td");
      if (cells.length !== 4) return undefined;
      const name = $(cells[0]).text().trim();
      if (!name) return undefined;
      const variantName = $(cells[1]).text().trim();
      const quantity = integer($(cells[2]).text().trim(), "order quantity");
      const lineTotal = price($(cells[3]).text().trim());
      if (!Number.isFinite(lineTotal))
        throw new DailyMealsError(
          "MALFORMED_SITE_HTML",
          "DailyMeals completed order data is incomplete.",
        );
      return { name, variantName, quantity, lineTotal };
    })
    .get()
    .filter((item): item is HistoricalOrderItem => item !== undefined);
  if (!items.length)
    throw new DailyMealsError(
      "MALFORMED_SITE_HTML",
      "DailyMeals completed order contains no dishes.",
    );
  return items;
}

function readTextOrValue(
  card: cheerio.Cheerio<unknown>,
  selector: string,
) {
  const element = card.find(selector).first();
  return normalizeText(element.text()) || element.val()?.toString().trim() || "";
}

function isMenuCardControl(name: string) {
  return (
    name === "dish_id" ||
    name === "dish_revision" ||
    name === "dish_variant_id" ||
    name.startsWith("dish_order[")
  );
}

function addSuccessfulControl(
  form: Map<string, string[]>,
  control: cheerio.Cheerio<unknown>,
  name: string,
) {
  const values = form.get(name) ?? [];
  collectSuccessfulControlValues(control, values);
  if (values.length) form.set(name, values);
}

function collectSuccessfulControlValues(
  control: cheerio.Cheerio<unknown>,
  values: string[],
) {
  if (control.is(":disabled")) return;
  const type = control.attr("type");
  if ((type === "checkbox" || type === "radio") && !control.is(":checked"))
    return;
  const value = control.val();
  if (Array.isArray(value)) values.push(...value.map(String));
  else values.push(value?.toString() ?? "");
}

function readDeliveryTimeOptions($: cheerio.CheerioAPI) {
  const byValue = new Map<string, { value: string; label: string }>();
  $("[name]")
    .filter((_, element) => deliveryTimeNames.has($(element).attr("name") ?? ""))
    .each((_, element) => {
      const control = $(element);
      if (control.is("select")) {
        control.find("option").each((__, optionElement) => {
          const option = $(optionElement);
          const value = option.val()?.toString() ?? "";
          if (value && value !== "on")
            byValue.set(value, {
              value,
              label: normalizeText(option.text()) || value,
            });
        });
        return;
      }
      const value = control.val()?.toString() ?? "";
      if (!value || value === "on") return;
      byValue.set(value, { value, label: controlLabel($, control) || value });
    });
  return [...byValue.values()];
}

function controlLabel(
  $: cheerio.CheerioAPI,
  control: cheerio.Cheerio<unknown>,
) {
  const id = control.attr("id");
  if (id) {
    const associated = $("label")
      .filter((_, label) => $(label).attr("for") === id)
      .first();
    if (associated.length) return normalizeText(associated.text());
  }
  const wrapped = control.closest("label");
  if (wrapped.length) return normalizeText(wrapped.text());
  const next = control.next("label");
  return next.length ? normalizeText(next.text()) : "";
}
