import { describe, expect, it } from "vitest";
import type { ProgramOptimizationIR } from "../ir.js";
import { freezeOptimizationValue } from "../state.js";

const assertDeepReadonlyQueryView = (ir: ProgramOptimizationIR): void => {
  const expression = ir.modules.get("src::main")?.hir.expressions.get(1);
  if (expression?.exprKind !== "block") {
    return;
  }
  // @ts-expect-error Optimizer queries cannot mutate nested HIR topology.
  expression.value = 2;
};
void assertDeepReadonlyQueryView;

describe("optimizer mutation contract", () => {
  it("freezes optimizer-owned HIR nodes against runtime mutation bypasses", () => {
    const expression = freezeOptimizationValue({
      kind: "expr" as const,
      exprKind: "block" as const,
      value: 1,
      statements: [2],
    });

    expect(() => {
      (expression as { value: number }).value = 3;
    }).toThrow();
    expect(() => {
      (expression.statements as number[]).push(4);
    }).toThrow();
  });
});
