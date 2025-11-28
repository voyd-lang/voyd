import { describe, it, expect, vi } from "vitest";

// Tests environment detection logic for parse-std

describe("parse-std environment detection", () => {
  it("uses browser path when process lacks node version", async () => {
    const original = (globalThis as any).process;
    (globalThis as any).process = { ...original, versions: {} };
    vi.resetModules();
    const mod = await import("./parse-std.js");
    expect(mod.stdPath).toBe("std");
    const parsed = await mod.parseStd();
    expect(Object.keys(parsed).length).toBeGreaterThan(0);
    (globalThis as any).process = original;
  });

  it("uses node path when process is defined", async () => {
    vi.resetModules();
    const mod = await import("./parse-std.js");
    expect(mod.stdPath).not.toBe("std");
  });
});
