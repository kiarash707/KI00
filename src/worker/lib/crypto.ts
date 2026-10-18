import { fromBase64, safeEqual, toBase64 } from "./utils";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const PASSWORD_ITERATIONS = 210_000;

export function randomToken(bytes = 32): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return toBase64(data).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Base64(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return toBase64(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function hashPassword(
  password: string,
  saltHex?: string,
  iterations = PASSWORD_ITERATIONS
): Promise<{ hash: string; salt: string; iterations: number }> {
  const salt = saltHex ?? bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: hexToBytes(salt),
      iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    256
  );
  return { hash: bytesToHex(new Uint8Array(bits)), salt, iterations };
}

export async function verifyPassword(
  password: string,
  expectedHash: string,
  salt: string,
  iterations: number
): Promise<boolean> {
  const { hash } = await hashPassword(password, salt, iterations);
  return safeEqual(hash, expectedHash);
}

function decodeEncryptionKey(raw: string | undefined): Uint8Array {
  if (!raw) {
    throw new Error(
      "KI00_ENCRYPTION_KEY is not configured. Generate one with: openssl rand -base64 32"
    );
  }
  const key = fromBase64(raw.trim());
  if (key.length !== 32) {
    throw new Error("KI00_ENCRYPTION_KEY must decode to exactly 32 bytes (base64).");
  }
  return key;
}

type AesKeyUsage = "encrypt" | "decrypt" | "wrapKey" | "unwrapKey";

async function importAesKey(raw: string | undefined, usage: AesKeyUsage[]): Promise<CryptoKey> {
  const key = decodeEncryptionKey(raw);
  return crypto.subtle.importKey("raw", key, "AES-GCM", false, usage);
}

/** AES-256-GCM encryption for project environment values stored in D1. */
export async function encryptValue(plain: string, rawKey: string | undefined): Promise<string> {
  const key = await importAesKey(rawKey, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plain));
  return `v1.${toBase64(iv)}.${toBase64(new Uint8Array(cipher))}`;
}

export async function decryptValue(payload: string, rawKey: string | undefined): Promise<string> {
  const parts = payload.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw new Error("Unsupported encrypted value format");
  const key = await importAesKey(rawKey, ["decrypt"]);
  const iv = fromBase64(parts[1]!);
  const data = fromBase64(parts[2]!);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return decoder.decode(plain);
}

export function isEncryptionConfigured(rawKey: string | undefined): boolean {
  try {
    decodeEncryptionKey(rawKey);
    return true;
  } catch {
    return false;
  }
}

/** Hash a client IP with a per-deployment salt so audit logs never store raw IPs. */
export async function hashIp(ip: string, salt: string): Promise<string> {
  return sha256Base64(`${salt}:${ip}`).then((v) => v.slice(0, 22));
}

export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 4) return "••••";
  if (value.length <= 10) return `${value.slice(0, 1)}••••${value.slice(-1)}`;
  return `${value.slice(0, 3)}••••••${value.slice(-2)}`;
}

export function constantTimeEqual(a: string, b: string): boolean {
  return safeEqual(a, b);
}
