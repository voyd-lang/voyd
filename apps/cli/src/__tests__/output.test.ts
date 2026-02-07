import { describe, expect, it, vi } from "vitest";
import { printValue, stringifyOutput } from "../output.js";

describe("cli output", () => {
  it("serializes bigint, map, and typed arrays safely", () => {
    const value = {
      total: 7n,
      table: new Map([
        [
          "entry",
          {
            bytes: new Uint8Array([1, 2, 3]),
          },
        ],
      ]),
    };

    const parsed = JSON.parse(stringifyOutput(value)) as {
      total: string;
      table: Record<string, { bytes: number[] }>;
    };
    expect(parsed.total).toBe("7n");
    expect(parsed.table).toEqual({
      entry: {
        bytes: [1, 2, 3],
      },
    });
  });

  it("prints bigint values without throwing", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      printValue(42n);
      expect(logSpy).toHaveBeenCalledWith("42n");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("serializes circular references", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const value: { self?: unknown } = {};
      value.self = value;
      printValue(value);

      const output = logSpy.mock.calls[0]?.[0];
      expect(typeof output).toBe("string");
      expect(String(output)).toContain("[Circular]");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("serializes shared references without marking them as circular", () => {
    const shared = { count: 2 };
    const value = {
      first: shared,
      second: shared,
    };

    const output = stringifyOutput(value);
    const parsed = JSON.parse(output) as {
      first: { count: number };
      second: { count: number };
    };

    expect(parsed).toEqual({
      first: { count: 2 },
      second: { count: 2 },
    });
    expect(output).not.toContain("[Circular]");
  });
});
