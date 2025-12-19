import { describe, expect, it } from "vitest";
import { createHirBuilder } from "../hir/builder.js";
import { publicVisibility } from "../hir/index.js";

const span = { file: "test.voyd", start: 0, end: 1 };

describe("HirBuilder", () => {
  it("tracks module items and exports with visibility data", () => {
    const builder = createHirBuilder({
      path: "test",
      scope: 0,
      ast: 1,
      span,
    });

    const literalId = builder.addExpression({
      kind: "expr",
      exprKind: "literal",
      ast: 2,
      span,
      literalKind: "i32",
      value: "0",
    });

    const fnId = builder.addFunction({
      kind: "function",
      visibility: publicVisibility(),
      symbol: 10,
      ast: 3,
      span,
      parameters: [
        {
          symbol: 11,
          pattern: { kind: "identifier", symbol: 11 },
          span,
          mutable: false,
        },
      ],
      body: literalId,
    });

    builder.recordExport({
      symbol: 10,
      alias: "testFn",
      visibility: publicVisibility(),
      span,
      item: fnId,
    });

    const graph = builder.finalize();

    expect(graph.module.items).toContain(fnId);
    expect(graph.items.get(fnId)?.kind).toBe("function");
    expect(graph.module.exports).toEqual([
      {
        symbol: 10,
        alias: "testFn",
        visibility: publicVisibility(),
        span,
        item: fnId,
      },
    ]);
  });
});
