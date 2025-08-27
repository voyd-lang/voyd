import { describe, expect, test } from "vitest";
import { Call, Identifier, List, i32 } from "../../../syntax-objects/index.js";
import { inferTypeArgs } from "../infer-type-args.js";
import { getExprType } from "../get-expr-type.js";

describe("inferTypeArgs", () => {
  test("infers type params in nested structures", () => {
    const T = new Identifier({ value: "T" });
    const stringId = new Identifier({ value: "String" });

    const tupleParam = new List({
      value: [
        new Identifier({ value: "tuple" }),
        stringId.clone(),
        T.clone(),
      ],
    });

    const typeExpr = new Call({
      fnName: new Identifier({ value: "Array" }),
      args: new List({}),
      typeArgs: new List({ value: [tupleParam] }),
    });

    const tupleArg = new List({
      value: [
        new Identifier({ value: "tuple" }),
        stringId.clone(),
        i32.clone(),
      ],
    });

    const argExpr = new Call({
      fnName: new Identifier({ value: "Array" }),
      args: new List({}),
      typeArgs: new List({ value: [tupleArg] }),
    });

    const result = inferTypeArgs([T], [{ typeExpr, argExpr }]);

    expect(result).toBeInstanceOf(List);
    const alias = result?.exprAt(0);
    expect(alias?.isTypeAlias()).toBe(true);
    const type = getExprType(alias!);
    expect(type?.isPrimitiveType()).toBe(true);
    expect(type?.name.value).toBe("i32");
  });
});

