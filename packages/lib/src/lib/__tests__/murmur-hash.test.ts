import { test, expect, describe } from "vitest";
import { murmurHash3 } from "../murmur-hash.js";

describe("Murmur Hash", async () => {
  test("should return correct hash for an empty string", () => {
    const hash = murmurHash3("");
    expect(hash).toBe(0);
  });

  test("should return correct hash for a short string", () => {
    const hash = murmurHash3("abc");
    expect(hash).toBe(3017643002);
  });

  test("should return correct hash for a longer string", () => {
    const hash = murmurHash3("The quick brown fox jumps over the lazy dog");
    expect(hash).toBe(776992547);
  });

  test("should return correct hash for string with special characters", () => {
    const hash = murmurHash3("!@#$%^&*()");
    expect(hash).toBe(3947575985);
  });

  test("should return correct hash for numeric string", () => {
    const hash = murmurHash3("1234567890");
    expect(hash).toBe(839148365);
  });

  test("should return consistent hash for the same input", () => {
    const hash1 = murmurHash3("consistent");
    const hash2 = murmurHash3("consistent");
    expect(hash1).toBe(hash2);
  });

  test("should return different hashes for different inputs", () => {
    const hash1 = murmurHash3("input1");
    const hash2 = murmurHash3("input2");
    expect(hash1).not.toBe(hash2);
  });

  test("should handle non-ASCII characters", () => {
    const hash = murmurHash3("你好，世界");
    expect(hash).toBe(1975738373);
  });

  test("should return correct hash with non-zero seed", () => {
    const hash = murmurHash3("seeded", 123);
    expect(hash).toBe(1693092115);
  });
});
