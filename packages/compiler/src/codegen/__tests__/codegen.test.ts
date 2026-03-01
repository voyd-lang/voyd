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
import { DiagnosticEmitter } from "../../diagnostics/index.js";
import { createProgramHelperRegistry } from "../program-helpers.js";
import {
  compileFunctions,
  emitModuleExports,
  registerFunctionMetadata,
  registerImportMetadata,
} from "../functions.js";
import { buildRuntimeTypeArtifacts } from "../runtime-pass.js";
import { wasmRuntimeTypeFor } from "../runtime-types.js";
import {
  getFixedArrayWasmTypes,
  getStructuralTypeInfo,
  resolveStructuralTypeId,
} from "../types.js";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { buildProgramCodegenView } from "../../semantics/codegen-view/index.js";
import type { HirMatchExpr } from "../../semantics/hir/index.js";
import type { ProgramFunctionInstanceId, TypeId } from "../../semantics/ids.js";
import type {
  ModuleGraph,
  ModuleNode,
  ModulePath,
} from "../../modules/types.js";
import {
  createEffectInterner,
  createEffectTable,
} from "../../semantics/effects/effect-table.js";
import { createTypeArena } from "../../semantics/typing/type-arena.js";
import type {
  CodegenContext,
  FunctionMetadata,
  OutcomeValueBox,
  RuntimeTypeIdRegistryEntry,
} from "../context.js";

const loadAst = (fixtureName: string) => {
  const source = readFileSync(
    resolve(import.meta.dirname, "__fixtures__", fixtureName),
    "utf8",
  );
  return parse(source, fixtureName);
};

const loadSemanticsWithTyping = (
  fixtureName: string,
  typing: { arena: any; effects: any },
  options: { asStd?: boolean } = {},
) => {
  const form = loadAst(fixtureName);
  const asStd = options.asStd === true;
  const fixtureSegment = fixtureName
    .replace(/\.voyd$/, "")
    .replace(/[^a-zA-Z0-9_]/g, "_");
  const path: ModulePath = asStd
    ? { namespace: "std", segments: [fixtureSegment] }
    : { namespace: "src", segments: [] };
  const module: ModuleNode = {
    id: asStd ? `std::${fixtureSegment}` : fixtureName,
    path,
    origin: { kind: "file", filePath: fixtureName },
    ast: form,
    source: "",
    dependencies: [],
  };
  const graph: ModuleGraph = {
    entry: module.id,
    modules: new Map([[module.id, module]]),
    diagnostics: [],
  };
  return semanticsPipeline({
    module,
    graph,
    exports: new Map(),
    dependencies: new Map(),
    typing,
  });
};

const loadWasmInstance = (
  fixtureName: string,
  options: { asStd?: boolean } = {},
) => {
  const semantics = loadSemanticsWithTyping(
    fixtureName,
    {
      arena: createTypeArena(),
      effects: createEffectTable({ interner: createEffectInterner() }),
    },
    { asStd: options.asStd },
  );
  const { module } = codegen(semantics, { effectsHostBoundary: "off" });
  return getWasmInstance(module);
};

const loadMain = (fixtureName: string, options: { asStd?: boolean } = {}) => {
  const instance = loadWasmInstance(fixtureName, options);
  const main = instance.exports.main;
  expect(typeof main).toBe("function");
  return main as (...params: unknown[]) => unknown;
};

const getNominalPatternDesc = (
  typeId: TypeId,
  arena: { get: (typeId: TypeId) => any },
) => {
  const desc = arena.get(typeId);
  if (desc.kind === "nominal-object") {
    return desc;
  }
  if (desc.kind === "intersection" && typeof desc.nominal === "number") {
    const nominalDesc = arena.get(desc.nominal);
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
  testMode: false,
  effectsHostBoundary: "off",
  linearMemoryExport: "always",
  effectsMemoryExport: "auto",
  testScope: "all",
} as const;

const sanitizeIdentifier = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");

const buildCodegenProgram = (
  modules: readonly ReturnType<typeof semanticsPipeline>[],
): { mod: binaryen.Module; contexts: CodegenContext[] } => {
  const program = buildProgramCodegenView(modules);
  const mod = new binaryen.Module();
  mod.setFeatures(binaryen.Features.All);
  const rtt = createRttContext(mod);
  const effectsRuntime = createEffectRuntime(mod);
  const functions = new Map<string, Map<number, FunctionMetadata[]>>();
  const functionInstances = new Map<
    ProgramFunctionInstanceId,
    FunctionMetadata
  >();
  const moduleLetGetters = new Map();
  const outcomeValueTypes = new Map<string, OutcomeValueBox>();
  const runtimeTypeRegistry = new Map<TypeId, RuntimeTypeIdRegistryEntry>();
  const runtimeTypeIdsByKey = new Map<string, number>();
  const runtimeTypeIdCounter = { value: 1 };
  const diagnostics = new DiagnosticEmitter();
  const programHelpers = createProgramHelperRegistry();
  const structTypes = new Map();
  const structHeapTypes = new Map();
  const structuralIdCache = new Map<TypeId, TypeId | null>();
  const resolvingStructuralIds = new Set<TypeId>();
  const fixedArrayTypes = new Map();
  const contexts: CodegenContext[] = modules.map((sem) => ({
    program,
    module: program.modules.get(sem.moduleId)!,
    mod,
    moduleId: sem.moduleId,
    moduleLabel: sanitizeIdentifier(sem.hir.module.path),
    diagnostics,
    options: DEFAULT_OPTIONS,
    programHelpers,
    functions,
    functionInstances,
    moduleLetGetters,
    itemsToSymbols: new Map(),
    structTypes,
    structHeapTypes,
    structuralIdCache,
    resolvingStructuralIds,
    fixedArrayTypes,
    closureTypes: new Map(),
    functionRefTypes: new Map(),
    recursiveBinders: new Map(),
    runtimeTypeRegistry,
    runtimeTypeIds: {
      byKey: runtimeTypeIdsByKey,
      nextId: runtimeTypeIdCounter,
    },
    lambdaEnvs: new Map(),
    lambdaFunctions: new Map(),
    rtt,
    effectsRuntime,
    effectsBackend: undefined as any,
    effectsState: createEffectsState(),
    effectLowering: {
      sitesByExpr: new Map(),
      sites: [],
      callArgTemps: new Map(),
      tempTypeIds: new Map(),
    },
    outcomeValueTypes,
  }));

  const siteCounter = { current: 0 };
  contexts.forEach((ctx) => {
    ctx.effectsBackend = selectEffectsBackend(ctx);
  });
  contexts.forEach((ctx) => {
    ctx.effectLowering = ctx.effectsBackend.buildLowering({ ctx, siteCounter });
  });

  contexts.forEach(registerFunctionMetadata);
  contexts.forEach(registerImportMetadata);
  buildRuntimeTypeArtifacts(contexts);
  const entryModuleId = contexts[0]?.moduleId ?? modules[0]?.moduleId;
  if (!entryModuleId) {
    throw new Error("missing entry module for codegen test");
  }
  contexts.forEach((ctx) => compileFunctions({ ctx, contexts, entryModuleId }));
  emitModuleExports(contexts[0]!, contexts);

  return { mod, contexts };
};

describe("next codegen", () => {
  it("does not register RTT during metadata registration", () => {
    const ast = loadAst("recursive_type_alias.voyd");
    const semantics = semanticsPipeline(ast);
    const program = buildProgramCodegenView([semantics]);
    const mod = new binaryen.Module();
    mod.setFeatures(binaryen.Features.All);
    const rtt = createRttContext(mod);
    const effectsRuntime = createEffectRuntime(mod);
    const functions = new Map<string, Map<number, FunctionMetadata[]>>();
    const functionInstances = new Map<
      ProgramFunctionInstanceId,
      FunctionMetadata
    >();
    const outcomeValueTypes = new Map<string, OutcomeValueBox>();
    const runtimeTypeRegistry = new Map<TypeId, RuntimeTypeIdRegistryEntry>();
    const runtimeTypeIdsByKey = new Map<string, number>();
    const runtimeTypeIdCounter = { value: 1 };
    const diagnostics = new DiagnosticEmitter();
    const programHelpers = createProgramHelperRegistry();
    const structTypes = new Map();
    const structHeapTypes = new Map();
    const structuralIdCache = new Map<TypeId, TypeId | null>();
    const resolvingStructuralIds = new Set<TypeId>();
    const fixedArrayTypes = new Map();

    const ctx: CodegenContext = {
      program,
      module: program.modules.get(semantics.moduleId)!,
      mod,
      moduleId: semantics.moduleId,
      moduleLabel: sanitizeIdentifier(semantics.hir.module.path),
      diagnostics,
      options: DEFAULT_OPTIONS,
      programHelpers,
      functions,
      functionInstances,
      moduleLetGetters: new Map(),
      itemsToSymbols: new Map(),
      structTypes,
      structHeapTypes,
      structuralIdCache,
      resolvingStructuralIds,
      fixedArrayTypes,
      closureTypes: new Map(),
      functionRefTypes: new Map(),
      recursiveBinders: new Map(),
      runtimeTypeRegistry,
      runtimeTypeIds: {
        byKey: runtimeTypeIdsByKey,
        nextId: runtimeTypeIdCounter,
      },
      lambdaEnvs: new Map(),
      lambdaFunctions: new Map(),
      rtt,
      effectsRuntime,
      effectsBackend: undefined as any,
      effectsState: createEffectsState(),
      effectLowering: {
        sitesByExpr: new Map(),
        sites: [],
        callArgTemps: new Map(),
        tempTypeIds: new Map(),
      },
      outcomeValueTypes,
    };

    const siteCounter = { current: 0 };
    ctx.effectsBackend = selectEffectsBackend(ctx);
    ctx.effectLowering = ctx.effectsBackend.buildLowering({ ctx, siteCounter });
    registerFunctionMetadata(ctx);
    registerImportMetadata(ctx);

    expect(runtimeTypeRegistry.size).toBe(0);

    buildRuntimeTypeArtifacts([ctx]);
    expect(runtimeTypeRegistry.size).toBeGreaterThan(0);
  });

  it("supports operator overload methods", () => {
    const main = loadMain("operator_overload_eq.voyd");
    expect(main()).toBe(1);
  });

  it("canonicalizes recursive RTT keys for alpha-equivalent aliases", () => {
    const ast = loadAst("recursive_alias_alpha_equivalence.voyd");
    const semantics = semanticsPipeline(ast);
    const {
      contexts: [ctx],
    } = buildCodegenProgram([semantics]);

    const resolveAliasType = (name: string): TypeId => {
      const symbol = semantics.symbols.resolveTopLevel(name);
      if (typeof symbol !== "number") {
        throw new Error(`missing type alias symbol for ${name}`);
      }
      const key = `${symbol}<>`;
      const typeId = semantics.typing.typeAliases.getCachedInstance(key);
      if (typeof typeId !== "number") {
        throw new Error(`missing type alias instance for ${name}`);
      }
      return typeId;
    };

    const listA = resolveAliasType("ListA");
    const listB = resolveAliasType("ListB");
    const listAStructural = resolveStructuralTypeId(listA, ctx);
    const listBStructural = resolveStructuralTypeId(listB, ctx);
    if (
      typeof listAStructural !== "number" ||
      typeof listBStructural !== "number"
    ) {
      throw new Error("missing structural type ids for recursive aliases");
    }

    wasmRuntimeTypeFor(listA, ctx);
    wasmRuntimeTypeFor(listB, ctx);

    const entryA = ctx.runtimeTypeRegistry.get(listAStructural);
    const entryB = ctx.runtimeTypeRegistry.get(listBStructural);
    expect(entryA?.key).toBeDefined();
    expect(entryA?.key).toBe(entryB?.key);
    const runtimeIdA =
      entryA?.key === undefined
        ? undefined
        : ctx.runtimeTypeIds.byKey.get(entryA.key);
    const runtimeIdB =
      entryB?.key === undefined
        ? undefined
        : ctx.runtimeTypeIds.byKey.get(entryB.key);
    expect(runtimeIdA).toBeDefined();
    expect(runtimeIdA).toBe(runtimeIdB);
  });

  it("emits recursive wasm heap types for recursive objects", () => {
    const semantics = loadSemanticsWithTyping(
      "recursive_heap_types.voyd",
      {
        arena: createTypeArena(),
        effects: createEffectTable({ interner: createEffectInterner() }),
      },
      { asStd: true },
    );
    const {
      contexts: [ctx],
    } = buildCodegenProgram([semantics]);

    const resolveAliasType = (name: string): TypeId => {
      const symbol = semantics.symbols.resolveTopLevel(name);
      if (typeof symbol !== "number") {
        throw new Error(`missing type alias symbol for ${name}`);
      }
      const key = `${symbol}<>`;
      const typeId = semantics.typing.typeAliases.getCachedInstance(key);
      if (typeof typeId !== "number") {
        throw new Error(`missing type alias instance for ${name}`);
      }
      return typeId;
    };

    const typeNode = resolveAliasType("Node");
    const typeSelf = resolveAliasType("Self");

    wasmRuntimeTypeFor(typeNode, ctx);
    wasmRuntimeTypeFor(typeSelf, ctx);

    const infoNode = getStructuralTypeInfo(typeNode, ctx);
    const infoSelf = getStructuralTypeInfo(typeSelf, ctx);
    if (!infoNode || !infoSelf) {
      throw new Error(
        "missing structural type info for recursive heap type test",
      );
    }

    const nextType = infoNode.fieldMap.get("next")?.typeId;
    if (typeof nextType !== "number") {
      throw new Error("missing Node.next type");
    }
    const infoBox = getStructuralTypeInfo(nextType, ctx);
    if (!infoBox) {
      throw new Error("missing structural info for Box<Node>");
    }

    expect(infoNode.fieldMap.get("next")?.heapWasmType).toBe(
      infoBox.runtimeType,
    );
    expect(infoBox.fieldMap.get("v")?.heapWasmType).toBe(infoNode.runtimeType);
    expect(infoSelf.fieldMap.get("next")?.heapWasmType).toBe(
      infoSelf.runtimeType,
    );

    expect(infoNode.fieldMap.get("next")?.heapWasmType).not.toBe(
      ctx.rtt.baseType,
    );
    expect(infoSelf.fieldMap.get("next")?.heapWasmType).not.toBe(
      ctx.rtt.baseType,
    );
  });

  it("emits recursive wasm heap types for recursive FixedArray elements", () => {
    const semantics = loadSemanticsWithTyping(
      "recursive_fixed_array_heap_types.voyd",
      {
        arena: createTypeArena(),
        effects: createEffectTable({ interner: createEffectInterner() }),
      },
      { asStd: true },
    );
    const {
      contexts: [ctx],
    } = buildCodegenProgram([semantics]);

    const resolveAliasType = (name: string): TypeId => {
      const symbol = semantics.symbols.resolveTopLevel(name);
      if (typeof symbol !== "number") {
        throw new Error(`missing type alias symbol for ${name}`);
      }
      const key = `${symbol}<>`;
      const typeId = semantics.typing.typeAliases.getCachedInstance(key);
      if (typeof typeId !== "number") {
        throw new Error(`missing type alias instance for ${name}`);
      }
      return typeId;
    };

    const typeNode = resolveAliasType("Node");
    wasmRuntimeTypeFor(typeNode, ctx);

    const infoNode = getStructuralTypeInfo(typeNode, ctx);
    if (!infoNode) {
      throw new Error("missing structural type info for FixedArray recursion test");
    }

    const nextField = infoNode.fieldMap.get("next");
    if (!nextField || typeof nextField.typeId !== "number") {
      throw new Error("missing Node.next field info");
    }

    const fixedArray = getFixedArrayWasmTypes(nextField.typeId, ctx);
    expect(nextField.heapWasmType).toBe(fixedArray.type);
    expect(nextField.heapWasmType).not.toBe(ctx.rtt.baseType);
  });

  it("runs recursive heap types fixture", () => {
    const main = loadMain("recursive_heap_types.voyd", { asStd: true });
    expect(main()).toBe(18);
  });

  it("runs recursive fixed-array heap types fixture", () => {
    const main = loadMain("recursive_fixed_array_heap_types.voyd", {
      asStd: true,
    });
    expect(main()).toBe(7);
  });

  it("preserves declared types when allocating locals for fixed-array bindings", () => {
    const main = loadMain("fixed_array_declared_local_type.voyd", {
      asStd: true,
    });
    expect(main()).toBe(0);
  });

  it("emits wasm for the fib sample and runs main()", () => {
    const main = loadMain("fib.voyd");
    expect(main()).toBe(55);
  });

  it("short-circuits boolean and/or expressions", () => {
    const instance = loadWasmInstance("boolean_short_circuit.voyd");
    const guardedAnd = instance.exports.guarded_and;
    expect(typeof guardedAnd).toBe("function");
    expect((guardedAnd as () => number)()).toBe(2);

    const guardedOr = instance.exports.guarded_or;
    expect(typeof guardedOr).toBe("function");
    expect((guardedOr as () => number)()).toBe(3);

    const main = instance.exports.main;
    expect(typeof main).toBe("function");
    expect((main as () => number)()).toBe(5);
  });

  it("coerces declared bindings to annotated optional types", () => {
    const main = loadMain("optional_binding_coercion.voyd");
    expect(main()).toBe(5);
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

  it("supports optional fields and parameters", () => {
    const instance = loadWasmInstance("optional_syntax.voyd");
    const {
      test1_optional_obj_field,
      test2_passed_optional_param,
      test3_not_passed_optional_param,
      test4_pass_optional_label_arg,
      test5_no_pass_optional_label,
      test6_pass_optional_object_for_label,
      test7_skip_optional_labeled,
      test8_closure_with_arg,
      test9_closure_without_arg,
      test10_optional_spread_wraps_some,
      main,
    } = instance.exports as Record<string, unknown>;

    expect((test1_optional_obj_field as () => number)()).toBe(7);
    expect((test2_passed_optional_param as () => number)()).toBe(2);
    expect((test3_not_passed_optional_param as () => number)()).toBe(1);
    expect((test4_pass_optional_label_arg as () => number)()).toBe(2);
    expect((test5_no_pass_optional_label as () => number)()).toBe(1);
    expect((test6_pass_optional_object_for_label as () => number)()).toBe(1);
    expect((test7_skip_optional_labeled as () => number)()).toBe(3);
    expect((test8_closure_with_arg as () => number)()).toBe(2);
    expect((test9_closure_without_arg as () => number)()).toBe(1);
    expect((test10_optional_spread_wraps_some as () => number)()).toBe(5);
    expect((main as () => number)()).toBe(25);
  });

  it("uses return_call for tail-recursive functions", () => {
    const ast = loadAst("tail_fib.voyd");
    const semantics = semanticsPipeline(ast);
    const { module } = codegen(semantics, { effectsHostBoundary: "off" });
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
    const { module } = codegen(semantics, { effectsHostBoundary: "off" });
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
      /(branch type mismatch|type mismatch)/,
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

  it("routes intrinsic fallback targets for unspecialized overload-set instances", () => {
    const instance = loadWasmInstance(
      "operator_overload_intrinsic_fallback_instances.voyd",
    );

    const callInt = instance.exports.call_int;
    expect(typeof callInt).toBe("function");
    expect((callInt as () => number)()).toBe(8);

    const callFloat = instance.exports.call_float;
    expect(typeof callFloat).toBe("function");
    expect((callFloat as () => number)()).toBeCloseTo(4);
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

  it("binds nominal match values via `as` patterns", () => {
    const main = loadMain("match_bind_value.voyd");
    expect(main()).toBe(4);
  });

  it("destructures nominal fields in match patterns", () => {
    const main = loadMain("match_destructure_fields.voyd");
    expect(main()).toBe(5);
  });

  it("matches tuple patterns and binds elements", () => {
    const main = loadMain("match_tuple_patterns.voyd");
    expect(main()).toBe(30);
  });

  it("matches nested patterns (nominal + tuple destructure)", () => {
    const main = loadMain("match_nested_patterns.voyd");
    expect(main()).toBe(34);
  });

  it("allows omitting type parameters for distinct nominal union members in match patterns", () => {
    const main = loadMain("match_union_distinct_nominal_omit_args.voyd");
    expect(main()).toBe(6);
  });

  it("diagnoses ambiguous match patterns when type parameters are omitted", () => {
    const ast = loadAst("match_union_ambiguous_nominal_omit_args.voyd");
    expect(() => semanticsPipeline(ast)).toThrow(/TY0020/);
  });

  it("lowers `if x is Type` chains into match for narrowing", () => {
    const main = loadMain("if_is_match_shorthand.voyd");
    expect(main()).toBe(5);
  });

  it("narrows `if x is Type` without else", () => {
    const main = loadMain("if_is_match_shorthand_no_else.voyd");
    expect(main()).toBe(5);
  });

  it("drops statement-if branch values to keep wasm valid", () => {
    const main = loadMain("if_statement_drops_branch_values.voyd");
    expect(main()).toBe(0);
  });

  it("drops statement-match arm values to keep wasm valid", () => {
    const main = loadMain("match_statement_drops_arm_values.voyd");
    expect(main()).toBe(0);
  });

  it("emits wasm for trait object dispatch", () => {
    const main = loadMain("trait_object_dispatch.voyd");
    expect(main()).toBe(53);
  });

  it("emits wasm for trait object dispatch via borrowed values", () => {
    const main = loadMain("trait_object_overload_dispatch.voyd");
    expect(main()).toBe(29);
  });

  it("emits wasm for overloaded trait object dispatch and qualified trait calls", () => {
    const main = loadMain("trait_object_overloaded_dispatch.voyd");
    expect(main()).toBe(22);
  });

  it("emits wasm for trait object dispatch on generic impl instantiations", () => {
    const instance = loadWasmInstance("trait_object_generic_impl_dispatch.voyd");
    const main = instance.exports.main;
    const mainF64 = instance.exports.main_f64;
    expect(typeof main).toBe("function");
    expect(typeof mainF64).toBe("function");
    expect((main as () => number)()).toBe(7);
    expect((mainF64 as () => number)()).toBeCloseTo(2.5);
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
    const { module } = codegen(semantics, { effectsHostBoundary: "off" });
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
    const result = codegen(semantics, { effectsHostBoundary: "off" });
    expect(result.diagnostics.some((diag) => diag.code === "CG0003")).toBe(
      true,
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
      (expr): expr is HirMatchExpr => expr.exprKind === "match",
    );

    expect(matches.length).toBeGreaterThan(0);
    matches.forEach((match) =>
      match.arms
        .filter((arm) => arm.pattern.kind === "type")
        .forEach((arm) => {
          expect(typeof arm.pattern.typeId).toBe("number");
          const patternDesc = getNominalPatternDesc(
            arm.pattern.typeId!,
            typing.arena,
          );
          const arg = typing.arena.get(patternDesc.typeArgs[0]!);
          expect(arg.kind).toBe("primitive");
          if (arg.kind !== "primitive") throw new Error("Expected primitive");
          expect(arg.name).toBe("i32");
        }),
    );
  });

  it("keeps distinct match pattern instantiations across generic union arms", () => {
    const ast = loadAst("generic_union_match.voyd");
    const { hir, typing } = semanticsPipeline(ast);
    const match = Array.from(hir.expressions.values()).find(
      (expr): expr is HirMatchExpr => expr.exprKind === "match",
    );

    expect(match).toBeDefined();
    const argNames =
      match?.arms
        .filter((arm) => arm.pattern.kind === "type")
        .map((arm) => {
          expect(typeof arm.pattern.typeId).toBe("number");
          const patternDesc = getNominalPatternDesc(
            arm.pattern.typeId!,
            typing.arena,
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
    const { module } = codegen(semantics, { effectsHostBoundary: "off" });
    const text = module.emitText();
    const typeLines = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("(type"));
    expect(
      typeLines.some((line) => line.includes("__closure_base_lambdas_voyd")),
    ).toBe(true);
    expect(
      typeLines.some(
        (line) =>
          line.includes("__lambda_env_12_") && line.includes("(mut i32"),
      ),
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

  it("resumes correctly when a method-call receiver precedes a suspending arg", () => {
    const main = loadMain("effects-method-call-resume.voyd");
    expect(main()).toBe(6);
  });

  it("handles attribute-tagged intrinsics through codegen", () => {
    const instance = loadWasmInstance("intrinsic_attributes_codegen.voyd", {
      asStd: true,
    });
    const main = instance.exports.main;
    expect(typeof main).toBe("function");
    expect((main as () => number)()).toBe(3);
    expect(typeof instance.exports.get_wrapper).toBe("function");
  });

  it("emits wasm for array literals via fixed_array_literal", () => {
    const main = loadMain("array_literal_codegen.voyd", { asStd: true });
    expect(main()).toBe(2);
  });

  it("keeps closure heap caches scoped per module and deterministic", () => {
    const arena = createTypeArena();
    const effectInterner = createEffectInterner();
    const moduleA = loadSemanticsWithTyping("lambda_multi_module_a.voyd", {
      arena,
      effects: createEffectTable({ interner: effectInterner }),
    });
    const moduleB = loadSemanticsWithTyping("lambda_multi_module_b.voyd", {
      arena,
      effects: createEffectTable({ interner: effectInterner }),
    });
    const {
      mod: combined,
      contexts: [ctxA, ctxB],
    } = buildCodegenProgram([moduleA, moduleB]);

    const lambdaCount = (sem: typeof moduleA) =>
      Array.from(sem.hir.expressions.values()).filter(
        (expr) => expr.exprKind === "lambda",
      ).length;

    const envKeysA = Array.from(ctxA.lambdaEnvs.keys());
    const envKeysB = Array.from(ctxB.lambdaEnvs.keys());
    expect(
      envKeysA.every((key) => key.startsWith(`${moduleA.moduleId}::`)),
    ).toBe(true);
    expect(
      envKeysB.every((key) => key.startsWith(`${moduleB.moduleId}::`)),
    ).toBe(true);
    expect(new Set([...envKeysA, ...envKeysB]).size).toBe(
      envKeysA.length + envKeysB.length,
    );
    expect(ctxA.lambdaEnvs.size).toBeLessThanOrEqual(lambdaCount(moduleA));
    expect(ctxB.lambdaEnvs.size).toBeLessThanOrEqual(lambdaCount(moduleB));
    expect(ctxA.lambdaEnvs.size + ctxB.lambdaEnvs.size).toBeGreaterThan(0);

    const closureKeysA = Array.from(ctxA.closureTypes.keys());
    const closureKeysB = Array.from(ctxB.closureTypes.keys());
    expect(
      closureKeysA.every((key) => key.startsWith(`${moduleA.moduleId}::`)),
    ).toBe(true);
    expect(
      closureKeysB.every((key) => key.startsWith(`${moduleB.moduleId}::`)),
    ).toBe(true);
    expect(new Set([...closureKeysA, ...closureKeysB]).size).toBe(
      closureKeysA.length + closureKeysB.length,
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
