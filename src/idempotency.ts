import { DailyMealsError } from "./errors.js";

export interface IdempotencyStore {
  claim(key: string): Promise<void>;
  complete(key: string): Promise<void>;
  release(key: string): Promise<void>;
}

export class IdempotencyCoordinator implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST")
      return new Response("Method Not Allowed", { status: 405 });

    switch (new URL(request.url).pathname) {
      case "/claim":
        if (await this.state.storage.get("status"))
          return new Response("Idempotency key already used", { status: 409 });
        await this.state.storage.put("status", "pending");
        return new Response(null, { status: 204 });
      case "/complete":
        await this.state.storage.put("status", "completed");
        return new Response(null, { status: 204 });
      case "/release":
        await this.state.storage.delete("status");
        return new Response(null, { status: 204 });
      default:
        return new Response("Not Found", { status: 404 });
    }
  }
}

export class DurableObjectStore implements IdempotencyStore {
  constructor(private readonly namespace: DurableObjectNamespace) {}

  async claim(key: string) {
    await this.request(key, "claim");
  }

  async complete(key: string) {
    await this.request(key, "complete");
  }

  async release(key: string) {
    await this.request(key, "release");
  }

  private async request(key: string, action: "claim" | "complete" | "release") {
    const id = this.namespace.idFromName(key);
    const response = await this.namespace
      .get(id)
      .fetch(`https://idempotency/${action}`, { method: "POST" });
    if (response.status === 409)
      throw new DailyMealsError(
        "IDEMPOTENCY_KEY_REUSED",
        "That idempotency key has already been used.",
      );
    if (!response.ok)
      throw new Error(`Idempotency store returned HTTP ${response.status}.`);
  }
}
