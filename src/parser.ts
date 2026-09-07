import * as cheerio from "cheerio";
import { DailyMealsError } from "./errors.js";
import type { Delivery, Dish, ParsedOrderPage } from "./types.js";

const integer = (value: string | undefined, label: string) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new DailyMealsError(
      "MALFORMED_SITE_HTML",
      `DailyMeals page has an invalid ${label}.`,
    );
  return number;
};

const price = (value: string) =>
  Number(value.replace(/[^0-9,.-]/g, "").replace(",", "."));

export function parseDeliveries(html: string): Delivery[] {
  const $ = cheerio.load(html);
  const seen = new Set<number>();
  const result: Delivery[] = [];
  $("a[href*='user-order']").each((_, element) => {
    const href = $(element).attr("href") ?? "";
    const match = href.match(/[?&]delivery_id=(\d+)/);

    if (!match || href.includes("user-order-save")) return;

    const id = integer(match[1], "delivery ID");

    if (seen.has(id)) return;
    seen.add(id);

    const row = $(element).closest("tr");
    const text = (row.length ? row : $(element).parent())
      .text()
      .replace(/\s+/g, " ")
      .trim();
    const editable = href.includes("user-order?");
    result.push({
      id,
      date: text,
      cutoff: text,
      status: text,
      deliveryTime: text,
      editable,
      orderPath: href,
    });
  });

  if (!result.length && html.includes("user-deliveries"))
    throw new DailyMealsError(
      "MALFORMED_SITE_HTML",
      "DailyMeals deliveries could not be parsed.",
    );

  return result;
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
    if (!name || input.is(":disabled")) return;
    if (
      (input.attr("type") === "checkbox" || input.attr("type") === "radio") &&
      !input.is(":checked")
    )
      return;
    form.set(name, [...(form.get(name) ?? []), input.val()?.toString() ?? ""]);
  });
  const formDeliveryId = integer(form.get("delivery_id")?.[0], "delivery ID");
  if (formDeliveryId !== expectedDeliveryId)
    throw new DailyMealsError(
      "INVALID_DELIVERY",
      "The returned order page belongs to another delivery.",
    );
  const deliveryTimes = formElement
    .find("input[name='selected_delivery_time_array[]']")
    .map((_, e) => $(e).val()?.toString() ?? "")
    .get()
    .filter(Boolean);
  const selectedDeliveryTimes =
    form.get("selected_delivery_time_array[]") ?? [];
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
    const name = card.find(".card-title").first().text().trim();
    const unitPrice = price(card.find("[name='dish-price']").first().text());
    const quantityOptions = card.find("select").first().find("option").length;
    if (!name || !Number.isFinite(unitPrice))
      throw new DailyMealsError(
        "MALFORMED_SITE_HTML",
        "DailyMeals dish data is incomplete.",
      );
    const variants = card
      .find("input[type='radio']")
      .map((_, radio) => {
        const r = $(radio);
        const variantId = r.prev("input").val()?.toString() ?? r.attr("value");
        return {
          id: integer(variantId, "variant ID"),
          name: r.next("label").text().trim(),
        };
      })
      .get();
    dishes.push({
      id,
      revision,
      name,
      price: unitPrice,
      availableQuantity: quantityOptions,
      variants,
    });
  });
  if (!dishes.length)
    throw new DailyMealsError(
      "MALFORMED_SITE_HTML",
      "DailyMeals menu contains no dishes.",
    );
  const items = new Map<string, Record<string, string>>();

  formElement.find("input[name^='dishes[']").each((_, element) => {
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
    selectedDeliveryTimes,
    dishes,
    currentItems,
    total: currentItems.reduce((sum, item) => sum + item.lineTotal, 0),
    canOrder,
  };
}
