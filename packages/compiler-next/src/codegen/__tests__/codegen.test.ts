import binaryen from "binaryen";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getWasmInstance } from "@voyd/lib/wasm.js";
import { codegen } from "../index.js";
import { createRttContext } from "../rtt/index.js";
import { createEffectRuntime } from "../effects/runtime-abi.js";
import { selectEffectsBackend } from "../effects/codegen-backend.js";
import { createEffectsState } from "../effects/state.js";
import {
  compileFunctions,
  emitModuleExports,
  registerFunctionMetadata,
  registerImportMetadata,
} from "../functions.js";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { buildEffectsLoweringInfo } from "../../semantics/effects/analysis.js";
import type { HirMatchExpr } from "../../semantics/hir/index.js";
import type { TypingResult } from "../../semantics/typing/types.js";
import type { TypeId } from "../../semantics/ids.js";
import type {
  CodegenContext,
  FunctionMetadata,
  OutcomeValueBox,
} from "../context.js";

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

const DEFAULT_OPTIONS = {
  optimize: false,
  validate: true,
  emitEffectHelpers: false,
  continuationBackend: {},
} as const;

const sanitizeIdentifier = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");

const buildCodegenProgram = (
  modules: readonly ReturnType<typeof semanticsPipeline>[]
): { mod: binaryen.Module; contexts: CodegenContext[] } => {
  const mod = new binaryen.Module();
  mod.setFeatures(binaryen.Features.All);
  const rtt = createRttContext(mod);
  const effectsRuntime = createEffectRuntime(mod);
  const functions = new Map<string, FunctionMetadata[]>();
  const functionInstances = new Map<string, FunctionMetadata>();
  const outcomeValueTypes = new Map<string, OutcomeValueBox>();
  const contexts: CodegenContext[] = modules.map((sem) => ({
    mod,
    moduleId: sem.moduleId,
    moduleLabel: sanitizeIdentifier(sem.hir.module.path),
    effectIdOffset: 0,
    binding: sem.binding,
    symbolTable: sem.symbolTable,
    hir: sem.hir,
    typing: sem.typing,
    effectsInfo: buildEffectsLoweringInfo({
      binding: sem.binding,
      symbolTable: sem.symbolTable,
      hir: sem.hir,
      typing: sem.typing,
    }),
    options: DEFAULT_OPTIONS,
    functions,
    functionInstances,
    itemsToSymbols: new Map(),
    structTypes: new Map(),
    fixedArrayTypes: new Map(),
    closureTypes: new Map(),
    functionRefTypes: new Map(),
    lambdaEnvs: new Map(),
    lambdaFunctions: new Map(),
    rtt,
    effectsRuntime,
    effectsBackend: undefined as any,
    effectsState: createEffectsState(),
    effectLowering: {
      sitesByExpr: new Map(),
      sites: [],
      argsTypes: new Map(),
      callArgTemps: new Map(),
      tempTypeIds: new Map(),
    },
    outcomeValueTypes,
  }));

  let effectIdOffset = 0;
  contexts.forEach((ctx) => {
    ctx.effectIdOffset = effectIdOffset;
    effectIdOffset += ctx.binding.effects.length;
  });

  const siteCounter = { current: 0 };
  contexts.forEach((ctx) => {
    ctx.effectsBackend = selectEffectsBackend(ctx);
  });
  contexts.forEach((ctx) => {
    ctx.effectLowering = ctx.effectsBackend.buildLowering({ ctx, siteCounter });
  });

  contexts.forEach(registerFunctionMetadata);
  contexts.forEach(registerImportMetadata);
  contexts.forEach(compileFunctions);
  emitModuleExports(contexts[0]!);

  return { mod, contexts };
};

describe("next codegen", () => {
  it("emits wasm for the fib sample and runs main()", () => {
    const main = loadMain("fib.voyd");
    expect(main()).toBe(55);
  });

  it("handles functions declared with `=` syntax and calls them", () => {
    const instance = loadWasmInstance("function_equals_syntax.voyd");

    const t1Call = instance.exports.t1_call;
    expect(typeof t1Call).toBe("function");
    expect((t1Call as () => number)()).toBe(1);

    const t2Call = instance.exports.t2_call;
    expect(typeof t2Call).toBe("function");
    expect((t2Call as () => number)()).toBe(2);

    const main = instance.exports.main;
    expect(typeof main).toBe("function");
    expect((main as () => number)()).toBe(3);
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

  it("handles return statements and preserves tail-call optimization", () => {
    const ast = loadAst("return_statements.voyd");
    const semantics = semanticsPipeline(ast);
    const { module } = codegen(semantics);
    const text = module.emitText();
    expect(text).toContain("return_call");
    const instance = getWasmInstance(module);
    const main = instance.exports.main;
    expect(typeof main).toBe("function");
    expect((main as () => number)()).toBe(15);
    const guarded = instance.exports.guarded_sum;
    expect(typeof guarded).toBe("function");
    expect((guarded as (n: number) => number)(-1)).toBe(-1);
  });

  it("emits wasm for the var inference sample and runs main()", () => {
    const main = loadMain("var_inference.voyd");
    expect(main()).toBe(55);
  });

  it("emits wasm for the recursive inference sample and runs main()", () => {
    const main = loadMain("recursive_inference.voyd");
    expect(main()).toBe(120);
  });

  it("infers union return types across nominal branches", () => {
    const main = loadMain("union_return_nominals.voyd");
    expect(main()).toBe(42);
  });

  it("rejects return values that do not match annotated unions", () => {
    const ast = loadAst("return_annotation_mismatch.voyd");
    expect(() => semanticsPipeline(ast)).toThrow(/return (type|statement)/i);
  });

  it("rejects incompatible primitive return branches", () => {
    const ast = loadAst("return_mixed_primitives.voyd");
    expect(() => semanticsPipeline(ast)).toThrow(
      /(branch type mismatch|type mismatch)/
    );
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

  it("emits wasm for trait object dispatch", () => {
    const main = loadMain("trait_object_dispatch.voyd");
    expect(main()).toBe(53);
  });

  it("emits wasm for trait object dispatch via overload sets", () => {
    const main = loadMain("trait_object_overload_dispatch.voyd");
    expect(main()).toBe(29);
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

  it("dispatches matches without widening runtime instantiations", () => {
    const instance = loadWasmInstance("alias_runtime_match.voyd");

    const matchNarrow = instance.exports.match_narrow;
    const matchWide = instance.exports.match_wide;
    const main = instance.exports.main;

    expect(typeof matchNarrow).toBe("function");
    expect(typeof matchWide).toBe("function");
    expect(typeof main).toBe("function");
    expect((matchNarrow as () => number)()).toBe(3);
    expect((matchWide as () => number)()).toBe(7);
    expect((main as () => number)()).toBe(37);
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
          if (arg.kind !== "primitive") throw new Error("Expected primitive");
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

  it("emits wasm for impl methods on nominal objects", () => {
    const main = loadMain("impl_methods.voyd");
    expect(main()).toBe(4);
  });

  it("emits wasm for impl methods with explicit method generics", () => {
    const main = loadMain("impl_method_generics.voyd");
    expect(main()).toBe(1);
  });

  it("emits wasm for trait defaults applied to impls", () => {
    const main = loadMain("trait_area.voyd");
    expect(main()).toBeCloseTo(24);
  });

  it("emits wasm for trait defaults on generic trait impls", () => {
    const main = loadMain("trait_generic_defaults.voyd");
    expect(main()).toBe(7);
  });

  it("emits wasm for blanket impls over any type parameter target", () => {
    const main = loadMain("blanket_scalable.voyd");
    expect(main()).toBe(4);
  });

  it("emits wasm for blanket impls on generic objects", () => {
    const main = loadMain("blanket_summable_box.voyd");
    expect(main()).toBe(7);
  });

  it("emits wasm for lambdas with captures, mutation, and nesting", () => {
    const main = loadMain("lambdas.voyd");
    expect(main()).toBe(75);
  });

  it("marks lambda captures mutable and reuses the canonical closure call_ref heap type", () => {
    const ast = loadAst("lambdas.voyd");
    const semantics = semanticsPipeline(ast);
    const { module } = codegen(semantics);
    const text = module.emitText();
    const typeLines = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("(type"));
    expect(
      typeLines.some((line) =>
        line.includes("__closure_base_lambdas_voyd")
      )
    ).toBe(true);
    expect(
      typeLines.some(
        (line) =>
          line.includes("__lambda_env_12_1") && line.includes("(mut i32")
      )
    ).toBe(true);
    const callRefs = text
      .split("\n")
      .filter((line) => line.trim().startsWith("(call_ref"));
    expect(callRefs.length).toBeGreaterThan(0);
    expect(callRefs.every((line) => /\$[A-Za-z0-9_]+/.test(line))).toBe(true);
    expect(callRefs.every((line) => !line.includes("funcref"))).toBe(true);
  });

  it("resolves overloads in nested lambda instances and preserves captures", () => {
    const main = loadMain("lambda_overload_instances.voyd");
    expect(main()).toBe(54);
  });

  it("coerces pure lambdas to open-effect function types", () => {
    const main = loadMain("lambda_open_effect_coercion.voyd");
    expect(main()).toBe(2);
  });

  it("resumes correctly when multiple suspending call arguments exist", () => {
    const main = loadMain("effects-multi-arg-resume.voyd");
    expect(main()).toBe(30);
  });

  it("handles attribute-tagged intrinsics through codegen", () => {
    const instance = loadWasmInstance("intrinsic_attributes_codegen.voyd");
    const main = instance.exports.main;
    expect(typeof main).toBe("function");
    expect((main as () => number)()).toBe(3);
    expect(typeof instance.exports.get_wrapper).toBe("function");
  });

  it("emits wasm for array literals via fixed_array_literal", () => {
    const main = loadMain("array_literal_codegen.voyd");
    expect(main()).toBe(2);
  });

  it("keeps closure heap caches scoped per module and deterministic", () => {
    const moduleA = semanticsPipeline(loadAst("lambda_multi_module_a.voyd"));
    const moduleB = semanticsPipeline(loadAst("lambda_multi_module_b.voyd"));
    const {
      mod: combined,
      contexts: [ctxA, ctxB],
    } = buildCodegenProgram([moduleA, moduleB]);

    const lambdaCount = (sem: typeof moduleA) =>
      Array.from(sem.hir.expressions.values()).filter(
        (expr) => expr.exprKind === "lambda"
      ).length;

    const envKeysA = Array.from(ctxA.lambdaEnvs.keys());
    const envKeysB = Array.from(ctxB.lambdaEnvs.keys());
    expect(envKeysA.every((key) => key.startsWith(`${moduleA.moduleId}::`))).toBe(
      true
    );
    expect(envKeysB.every((key) => key.startsWith(`${moduleB.moduleId}::`))).toBe(
      true
    );
    expect(new Set([...envKeysA, ...envKeysB]).size).toBe(
      envKeysA.length + envKeysB.length
    );
    expect(ctxA.lambdaEnvs.size).toBe(lambdaCount(moduleA));
    expect(ctxB.lambdaEnvs.size).toBe(lambdaCount(moduleB));

    const closureKeysA = Array.from(ctxA.closureTypes.keys());
    const closureKeysB = Array.from(ctxB.closureTypes.keys());
    expect(
      closureKeysA.every((key) => key.startsWith(`${moduleA.moduleId}::`))
    ).toBe(true);
    expect(
      closureKeysB.every((key) => key.startsWith(`${moduleB.moduleId}::`))
    ).toBe(true);
    expect(new Set([...closureKeysA, ...closureKeysB]).size).toBe(
      closureKeysA.length + closureKeysB.length
    );

    const {
      contexts: [ctxASecond, ctxBSecond],
      mod: combinedSecond,
    } = buildCodegenProgram([moduleA, moduleB]);
    expect(Array.from(ctxASecond.lambdaEnvs.keys())).toEqual(envKeysA);
    expect(Array.from(ctxBSecond.lambdaEnvs.keys())).toEqual(envKeysB);
    expect(Array.from(ctxASecond.closureTypes.keys())).toEqual(closureKeysA);
    expect(Array.from(ctxBSecond.closureTypes.keys())).toEqual(closureKeysB);

    combined.dispose();
    combinedSecond.dispose();
  });
});
