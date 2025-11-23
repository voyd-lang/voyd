import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getWasmInstance } from "../../../lib/wasm.js";
import { codegen } from "../index.js";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import type { HirMatchExpr } from "../../semantics/hir/index.js";
import type { TypingResult } from "../../semantics/typing/types.js";
import type { TypeId } from "../../semantics/ids.js";

const loadAst = (fixtureName: string) => {
  const source = readFileSync(
    resolve(import.meta.dirname, "__fixtures__", fixtureName),
    "utf8"
  );
  return parse(source, fixtureName);
};

const loadWasmInstance = (fixtureName: string) => {
  const ast = loadAst(fixtureName);
  const semantics = semanticsPipeline(ast);
  const { module } = codegen(semantics);
  return getWasmInstance(module);
};

const loadMain = (fixtureName: string) => {
  const instance = loadWasmInstance(fixtureName);
  const main = instance.exports.main;
  expect(typeof main).toBe("function");
  return main as (...params: unknown[]) => unknown;
};

const getNominalPatternDesc = (typeId: TypeId, typing: TypingResult) => {
  const desc = typing.arena.get(typeId);
  if (desc.kind === "nominal-object") {
    return desc;
  }
  if (desc.kind === "intersection" && typeof desc.nominal === "number") {
    const nominalDesc = typing.arena.get(desc.nominal);
    if (nominalDesc.kind === "nominal-object") {
      return nominalDesc;
    }
  }
  throw new Error("expected match pattern to include a nominal component");
};

describe("next codegen", () => {
  it("emits wasm for the fib sample and runs main()", () => {
    const main = loadMain("fib.voyd");
    expect(main()).toBe(55);
  });

  it("uses return_call for tail-recursive functions", () => {
    const ast = loadAst("tail_fib.voyd");
    const semantics = semanticsPipeline(ast);
    const { module } = codegen(semantics);
    const text = module.emitText();
    expect(text).toContain("return_call");
    const instance = getWasmInstance(module);
    const main = instance.exports.main;
    expect(typeof main).toBe("function");
    expect((main as () => number)()).toBe(55);
  });

  it("emits wasm for the var inference sample and runs main()", () => {
    const main = loadMain("var_inference.voyd");
    expect(main()).toBe(55);
  });

  it("emits wasm for the recursive inference sample and runs main()", () => {
    const main = loadMain("recursive_inference.voyd");
    expect(main()).toBe(120);
  });

  it("emits wasm for the function overloads sample and runs both call sites", () => {
    const instance = loadWasmInstance("function_overloads.voyd");

    const callInt = instance.exports.call_int;
    expect(typeof callInt).toBe("function");
    expect((callInt as () => number)()).toBe(3);

    const callFloat = instance.exports.call_float;
    expect(typeof callFloat).toBe("function");
    expect((callFloat as () => number)()).toBeCloseTo(3);

    const callFrom = instance.exports.call_from;
    expect(typeof callFrom).toBe("function");
    expect((callFrom as () => number)()).toBe(-1);

    const callTo = instance.exports.call_to;
    expect(typeof callTo).toBe("function");
    expect((callTo as () => number)()).toBe(3);
  });

  it("emits wasm for the elif sample and runs main()", () => {
    const main = loadMain("elif.voyd");
    expect(main()).toBe(0);
  });

  it("emits wasm for structural object literals and spreads", () => {
    const main = loadMain("structural_objects.voyd");
    expect(main()).toBe(21);
  });

  it("emits wasm for nominal objects and structural interop", () => {
    const main = loadMain("nominal_objects.voyd");
    expect(main()).toBe(21);
  });

  it("emits wasm for nominal objects with type parameters", () => {
    const main = loadMain("object_generics.voyd");
    expect(main()).toBe(7);
  });

  it("emits wasm for tuples treated as structural objects", () => {
    const main = loadMain("tuples.voyd");
    expect(main()).toBe(32);
  });

  it("emits wasm for UFCS calls to free functions", () => {
    const main = loadMain("ufcs.voyd");
    expect(main()).toBe(19);
  });

  it("emits wasm for union matches and returns the matched payload", () => {
    const main = loadMain("unions_match.voyd");

    expect(main()).toBe(1);
  });

  it("preserves nominal identity for structurally identical types in match guards", () => {
    const main = loadMain("nominal_identity_match.voyd");
    expect(main()).toBe(303);
  });

  it("includes base nominal ancestors for derived casts", () => {
    const main = loadMain("nominal_inheritance_match.voyd");
    expect(main()).toBe(7);
  });

  it("tracks multi-level generic nominal ancestry", () => {
    const main = loadMain("nominal_generic_inheritance.voyd");
    expect(main()).toBe(6);
  });

  it("preserves nominal identity for structurally identical types in match guards", () => {
    const ast = loadAst("nominal_identity_match.voyd");
    const semantics = semanticsPipeline(ast);
    const { module } = codegen(semantics);
    const instance = getWasmInstance(module);
    const main = instance.exports.main;
    expect(typeof main).toBe("function");
    expect((main as () => number)()).toBe(303);
  });

  it("emits wasm for type aliases with type parameters", () => {
    const main = loadMain("type_alias_generics.voyd");
    expect(main()).toBe(12);
  });

  it("emits wasm for recursive type aliases", () => {
    const main = loadMain("recursive_type_alias.voyd");
    expect(main()).toBe(8);
  });

  it("emits wasm for recursive generic type aliases", () => {
    const main = loadMain("recursive_generic_alias.voyd");
    expect(main()).toBe(2);
  });

  it("dispatches matches by concrete generic instantiation", () => {
    const main = loadMain("generic_union_match.voyd");
    expect(main()).toBe(35);
  });

  it("avoids widening generic match arms across instantiations", () => {
    const instance = loadWasmInstance("generic_union_exact_match.voyd");

    const matchI32 = instance.exports.match_i32;
    const matchF64 = instance.exports.match_f64;
    const main = instance.exports.main;

    expect(typeof matchI32).toBe("function");
    expect(typeof matchF64).toBe("function");
    expect((matchI32 as () => number)()).toBe(1);
    expect((matchF64 as () => number)()).toBe(-1);
    expect((main as () => number)()).toBe(3);
  });

  it("uses explicit generic instantiations during codegen", () => {
    const main = loadMain("explicit_generic_instantiation.voyd");
    expect(main()).toBe(7);
  });

  it("fails codegen for exported generic functions without instantiations", () => {
    const ast = loadAst("uninstantiated_export_generic.voyd");
    const semantics = semanticsPipeline(ast);
    expect(() => codegen(semantics)).toThrow(
      /concrete instantiation for exported generic function identity/
    );
  });

  it("emits wasm for generic functions", () => {
    const instance = loadWasmInstance("function_generics.voyd");
    const main1 = instance.exports.main1;
    const main2 = instance.exports.main2;
    expect(typeof main1).toBe("function");
    expect(typeof main2).toBe("function");
    expect((main1 as () => number)()).toBeCloseTo(3);
    expect((main2 as () => number)()).toBe(3);
  });

  it("records narrowed match pattern instantiations for generic union arms", () => {
    const ast = loadAst("generic_union_exact_match.voyd");
    const { hir, typing } = semanticsPipeline(ast);
    const matches = Array.from(hir.expressions.values()).filter(
      (expr): expr is HirMatchExpr => expr.exprKind === "match"
    );

    expect(matches.length).toBeGreaterThan(0);
    matches.forEach((match) =>
      match.arms
        .filter((arm) => arm.pattern.kind === "type")
        .forEach((arm) => {
          expect(typeof arm.pattern.typeId).toBe("number");
          const patternDesc = getNominalPatternDesc(
            arm.pattern.typeId!,
            typing
          );
          const arg = typing.arena.get(patternDesc.typeArgs[0]!);
          expect(arg.kind).toBe("primitive");
          expect(arg.name).toBe("i32");
        })
    );
  });

  it("keeps distinct match pattern instantiations across generic union arms", () => {
    const ast = loadAst("generic_union_match.voyd");
    const { hir, typing } = semanticsPipeline(ast);
    const match = Array.from(hir.expressions.values()).find(
      (expr): expr is HirMatchExpr => expr.exprKind === "match"
    );

    expect(match).toBeDefined();
    const argNames =
      match?.arms
        .filter((arm) => arm.pattern.kind === "type")
        .map((arm) => {
          expect(typeof arm.pattern.typeId).toBe("number");
          const patternDesc = getNominalPatternDesc(
            arm.pattern.typeId!,
            typing
          );
          const arg = typing.arena.get(patternDesc.typeArgs[0]!);
          if (arg.kind !== "primitive") {
            throw new Error("expected primitive type argument");
          }
          return arg.name;
        }) ?? [];

    expect(argNames).toEqual(["f64", "i32"]);
  });

  it("it doesn't produce an illegal cast at runtime", () => {
    const main = loadMain("illegal_cast.voyd");
    expect(main()).toBe(17);
  });
});
