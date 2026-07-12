import { describe, expect, it } from "vitest";
import { defineVoydPackageAdapter } from "./index.js";

const contract = {
  abiVersion: 1 as const,
  packageName: "example",
  functions: [
    {
      kind: "sync" as const,
      interfaceId: "example:math/ops@1",
      functionName: "double",
      params: [{ kind: "i32" as const }],
      result: { kind: "i32" as const },
    },
  ],
};

describe("defineVoydPackageAdapter", () => {
  it("defines an immutable descriptor for a complete implementation", () => {
    const adapter = defineVoydPackageAdapter(contract, {
      "example:math/ops@1": { double: (value: number) => value * 2 },
    });

    expect(adapter.kind).toBe("voyd-package-adapter");
    expect(adapter.contract).toMatchObject(contract);
    expect(adapter.contract.interfaces).toHaveLength(1);
    expect(Object.isFrozen(adapter)).toBe(true);
  });

  it("rejects missing and unknown functions", () => {
    expect(() => defineVoydPackageAdapter(contract, {})).toThrow(/missing external functions/);
    expect(() =>
      defineVoydPackageAdapter(contract, {
        "example:math/ops@1": {
          double: (value: number) => value * 2,
          triple: (value: number) => value * 3,
        },
      }),
    ).toThrow(/unknown external function/);
  });
});
