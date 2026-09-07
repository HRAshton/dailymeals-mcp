import { Firestore } from "@google-cloud/firestore";
import { DailyMealsError } from "./errors.js";

export interface IdempotencyStore {
  claim(key: string): Promise<void>;
  complete(key: string): Promise<void>;
  release(key: string): Promise<void>;
}

export class MemoryStore implements IdempotencyStore {
  private keys = new Set<string>();
  async claim(key: string) {
    if (this.keys.has(key))
      throw new DailyMealsError(
        "IDEMPOTENCY_KEY_REUSED",
        "That idempotency key has already been used.",
      );
    this.keys.add(key);
  }

  async complete() {}

  async release() {}
}

class FirestoreStore implements IdempotencyStore {
  private readonly db = new Firestore();

  constructor(private readonly collection: string) {}

  async claim(key: string) {
    const ref = this.db.collection(this.collection).doc(key);
    await this.db.runTransaction(async (transaction) => {
      if ((await transaction.get(ref)).exists)
        throw new DailyMealsError(
          "IDEMPOTENCY_KEY_REUSED",
          "That idempotency key has already been used.",
        );
      transaction.create(ref, { status: "pending", createdAt: new Date() });
    });
  }

  async complete(key: string) {
    await this.db
      .collection(this.collection)
      .doc(key)
      .update({ status: "completed", completedAt: new Date() });
  }

  async release(key: string) {
    await this.db.collection(this.collection).doc(key).delete();
  }
}
export function idempotencyStore(): IdempotencyStore {
  const collection = process.env.FIRESTORE_IDEMPOTENCY_COLLECTION;

  if (collection) return new FirestoreStore(collection);

  if (
    process.env.NODE_ENV !== "production" &&
    process.env.IDEMPOTENCY_BACKEND === "memory"
  )
    return new MemoryStore();

  throw new Error(
    "FIRESTORE_IDEMPOTENCY_COLLECTION is required in production for safe order submission.",
  );
}
