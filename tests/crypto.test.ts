import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  constantTimeEqual,
  decryptValue,
  encryptValue,
  hashPassword,
  maskSecret,
  sha256Hex,
  verifyPassword,
} from "../src/worker/lib/crypto";
import { redactSecrets, slugify, workerNameFor } from "../src/worker/lib/utils";

const key = randomBytes(32).toString("base64");

describe("secret encryption", () => {
  it("round-trips an AES-GCM value and produces a different ciphertext each time", async () => {
    const first = await encryptValue("postgres://user:pass@host/db", key);
    const second = await encryptValue("postgres://user:pass@host/db", key);
    expect(first).not.toBe(second);
    expect(first.startsWith("v1.")).toBe(true);
    expect(await decryptValue(first, key)).toBe("postgres://user:pass@host/db");
    expect(await decryptValue(second, key)).toBe("postgres://user:pass@host/db");
  });

  it("rejects a key that is not 32 bytes", async () => {
    await expect(encryptValue("value", randomBytes(16).toString("base64"))).rejects.toThrow(/32 bytes/);
  });

  it("fails closed when the encryption key is missing", async () => {
    await expect(encryptValue("value", undefined)).rejects.toThrow();
  });

  it("rejects tampered ciphertext", async () => {
    const encrypted = await encryptValue("value", key);
    const parts = encrypted.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]!.slice(0, -4)}AAAA`;
    await expect(decryptValue(tampered, key)).rejects.toThrow();
  });
});

describe("password hashing", () => {
  it("hashes with PBKDF2 and verifies the correct password only", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.iterations).toBe(210_000);
    expect(hash.hash).not.toContain("correct horse");
    expect(await verifyPassword("correct horse battery staple", hash.hash, hash.salt, hash.iterations)).toBe(true);
    expect(await verifyPassword("wrong password", hash.hash, hash.salt, hash.iterations)).toBe(false);
  }, 20_000);
});

describe("helpers", () => {
  it("masks secrets without exposing their content", () => {
    expect(maskSecret("super-secret-value")).toBe("sup••••••ue");
    expect(maskSecret("")).toBe("");
    expect(maskSecret("abc")).toBe("••••");
  });

  it("compares strings in constant time", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });

  it("hashes deterministically", async () => {
    expect(await sha256Hex("ki00")).toBe(await sha256Hex("ki00"));
    expect((await sha256Hex("ki00")).length).toBe(64);
  });

  it("redacts provider tokens and registered secrets from logs", () => {
    const token = "sk-or-v1-" + "a".repeat(40);
    const text = `Authorization: Bearer ${token}\nuser value ${key}\nghp_${"b".repeat(36)}`;
    const redacted = redactSecrets(text, [key]);
    expect(redacted).not.toContain(token);
    expect(redacted).not.toContain(key);
    expect(redacted).not.toContain("ghp_");
    expect(redacted).toContain("[REDACTED]");
  });

  it("builds a safe worker name from a slug", () => {
    expect(slugify("My Cool App!")).toBe("my-cool-app");
    expect(workerNameFor("my-cool-app")).toBe("ki00-my-cool-app");
    expect(workerNameFor("a".repeat(80)).length).toBeLessThanOrEqual(54);
  });
});
