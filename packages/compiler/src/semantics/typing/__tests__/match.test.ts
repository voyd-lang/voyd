import { describe, expect, it } from "vitest";
import { loadAst } from "../../__tests__/load-ast.js";
import { semanticsPipeline } from "../../pipeline.js";
import { getSymbolTable } from "../../_internal/symbol-table.js";
import type { SymbolTable } from "../../binder/index.js";

const findSymbolByName = (
  name: string,
  kind: "value" | "parameter",
  symbolTable: SymbolTable
) =>
  symbolTable
    .snapshot()
    .symbols.find((record) => record.name === name && record.kind === kind)?.id;

describe("match expressions", () => {
  it("typechecks unions and narrows match arms", () => {
    const ast = loadAst("unions_match.voyd");
    const semantics = semanticsPipeline(ast);
    const { typing, hir } = semantics;
    const symbolTable = getSymbolTable(semantics);

    const numSymbol = findSymbolByName("num", "value", symbolTable);
    expect(numSymbol).toBeDefined();
    const numTypeId =
      typeof numSymbol === "number" ? typing.valueTypes.get(numSymbol) : undefined;
    expect(numTypeId).toBeDefined();
    if (typeof numTypeId !== "number") {
      return;
    }

    const numType = typing.arena.get(numTypeId);
    expect(numType).toMatchObject({ kind: "function" });
    if (numType.kind !== "function") {
      return;
    }

    const petParamType = numType.parameters[0]!.type;
    const petUnion = typing.arena.get(petParamType);
    expect(petUnion).toMatchObject({ kind: "union" });
    if (petUnion.kind === "union") {
      expect(petUnion.members.length).toBe(3);
    }

    const matchExpr = Array.from(hir.expressions.values()).find(
      (candidate) => candidate.exprKind === "match"
    );
    expect(matchExpr).toBeDefined();
    const matchType =
      matchExpr && typing.table.getExprType(matchExpr.id as number);
    expect(matchType).toBeDefined();
    if (typeof matchType === "number") {
      expect(typing.arena.get(matchType)).toMatchObject({
        kind: "primitive",
        name: "i32",
      });
    }
  });

  it("allows omitting type parameters for unique nominal union members in patterns", () => {
    const ast = loadAst("match_union_nominal_infer_args.voyd");
    const { typing, hir } = semanticsPipeline(ast);

    const matchExpr = Array.from(hir.expressions.values()).find(
      (candidate) => candidate.exprKind === "match"
    );
    expect(matchExpr).toBeDefined();
    if (!matchExpr || matchExpr.exprKind !== "match") {
      return;
    }

    const somePattern = matchExpr.arms[0]?.pattern;
    expect(somePattern?.kind).toBe("type");
    if (somePattern?.kind !== "type") {
      return;
    }

    const patternType = somePattern.typeId;
    expect(typeof patternType).toBe("number");
    if (typeof patternType !== "number") {
      return;
    }

    const desc = typing.arena.get(patternType);
    expect(desc.kind).toBe("intersection");
    if (desc.kind !== "intersection") {
      return;
    }

    expect(typeof desc.nominal).toBe("number");
    if (typeof desc.nominal !== "number") {
      return;
    }

    const nominalDesc = typing.arena.get(desc.nominal);
    expect(nominalDesc.kind).toBe("nominal-object");
    if (nominalDesc.kind !== "nominal-object") {
      return;
    }

    const [typeArg] = nominalDesc.typeArgs;
    expect(typeof typeArg).toBe("number");
    if (typeof typeArg !== "number") {
      return;
    }
    const argDesc = typing.arena.get(typeArg);
    expect(argDesc.kind).toBe("primitive");
    if (argDesc.kind === "primitive") {
      expect(argDesc.name).toBe("i32");
    }
  });

  it("infers nominal type arguments for locally declared discriminants when the nominal is unique", () => {
    const ast = loadAst("match_union_nominal_infer_args_local_binding.voyd");
    const semantics = semanticsPipeline(ast);
    const { typing, hir } = semantics;
    const symbolTable = getSymbolTable(semantics);

    const matchExpr = Array.from(hir.expressions.values()).find(
      (candidate) => candidate.exprKind === "match"
    );
    expect(matchExpr).toBeDefined();
    if (!matchExpr || matchExpr.exprKind !== "match") {
      return;
    }

    const somePattern = matchExpr.arms[0]?.pattern;
    expect(somePattern?.kind).toBe("type");
    if (somePattern?.kind !== "type") {
      return;
    }

    const patternType = somePattern.typeId;
    expect(typeof patternType).toBe("number");
    if (typeof patternType !== "number") {
      return;
    }

    const desc = typing.arena.get(patternType);
    expect(desc.kind).toBe("intersection");
    if (desc.kind !== "intersection") {
      return;
    }

    expect(typeof desc.nominal).toBe("number");
    if (typeof desc.nominal !== "number") {
      return;
    }

    const nominalDesc = typing.arena.get(desc.nominal);
    expect(nominalDesc.kind).toBe("nominal-object");
    if (nominalDesc.kind !== "nominal-object") {
      return;
    }

    const [typeArg] = nominalDesc.typeArgs;
    expect(typeof typeArg).toBe("number");
    if (typeof typeArg !== "number") {
      return;
    }
    const argDesc = typing.arena.get(typeArg);
    expect(argDesc.kind).toBe("primitive");
    if (argDesc.kind === "primitive") {
      expect(argDesc.name).toBe("i32");
    }

    const binding = findSymbolByName("o", "value", symbolTable);
    expect(binding).toBeDefined();
    if (typeof binding !== "number") {
      return;
    }
    const boundType = typing.valueTypes.get(binding);
    expect(typeof boundType).toBe("number");
    if (typeof boundType !== "number") {
      return;
    }
    const boundDesc = typing.arena.get(boundType);
    expect(boundDesc.kind).toBe("union");
  });

  it("respects tuple-bound annotations when inferring nominal pattern arguments", () => {
    const ast = loadAst("match_union_nominal_infer_args_tuple_binding.voyd");
    const { typing, hir } = semanticsPipeline(ast);

    const matchExpr = Array.from(hir.expressions.values()).find(
      (candidate) => candidate.exprKind === "match"
    );
    expect(matchExpr).toBeDefined();
    if (!matchExpr || matchExpr.exprKind !== "match") {
      return;
    }

    const somePattern = matchExpr.arms[0]?.pattern;
    expect(somePattern?.kind).toBe("type");
    if (somePattern?.kind !== "type") {
      return;
    }

    const patternType = somePattern.typeId;
    expect(typeof patternType).toBe("number");
    if (typeof patternType !== "number") {
      return;
    }

    const desc = typing.arena.get(patternType);
    expect(desc.kind).toBe("intersection");
    if (desc.kind !== "intersection") {
      return;
    }

    expect(typeof desc.nominal).toBe("number");
    if (typeof desc.nominal !== "number") {
      return;
    }

    const nominalDesc = typing.arena.get(desc.nominal);
    expect(nominalDesc.kind).toBe("nominal-object");
    if (nominalDesc.kind !== "nominal-object") {
      return;
    }

    const [typeArg] = nominalDesc.typeArgs;
    expect(typeof typeArg).toBe("number");
    if (typeof typeArg !== "number") {
      return;
    }
    const argDesc = typing.arena.get(typeArg);
    expect(argDesc.kind).toBe("primitive");
    if (argDesc.kind === "primitive") {
      expect(argDesc.name).toBe("i32");
    }
  });

  it("errors when omitting type parameters for repeated nominal union members", () => {
    expect(() =>
      semanticsPipeline(
        loadAst("match_union_nominal_infer_args_ambiguous.voyd")
      )
    ).toThrow(/ambiguous match pattern 'A'/i);
  });
});
