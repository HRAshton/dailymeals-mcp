const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type OAuthPayload = Record<string, unknown> & {
  type: "client" | "code" | "access";
  expiresAt?: number;
};

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const decode = (value: string) => {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(
    atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=")),
    (character) => character.charCodeAt(0),
  );
};

async function key(secret: string) {
  const bytes = decode(secret);
  if (bytes.length !== 32) throw new Error("OAUTH_TOKEN_KEY must be 32 bytes.");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function seal(payload: OAuthPayload, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await key(secret),
    encoder.encode(JSON.stringify(payload)),
  );
  return `${base64url(iv)}.${base64url(new Uint8Array(encrypted))}`;
}

export async function unseal<T extends OAuthPayload>(
  value: string,
  secret: string,
) {
  const [iv, ciphertext, extra] = value.split(".");
  if (!iv || !ciphertext || extra) return undefined;
  try {
    return JSON.parse(
      decoder.decode(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: decode(iv) },
          await key(secret),
          decode(ciphertext),
        ),
      ),
    ) as T;
  } catch {
    return undefined;
  }
}

export async function pkce(verifier: string) {
  return base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(verifier)),
    ),
  );
}

export const randomId = () =>
  base64url(crypto.getRandomValues(new Uint8Array(24)));
