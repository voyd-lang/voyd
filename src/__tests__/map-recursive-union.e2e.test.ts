import { describe, test, beforeAll } from "vitest";
import { parseModule } from "../parser/index.js";
import { processSemantics } from "../semantics/index.js";
import { mapRecursiveUnionVoyd } from "./fixtures/map-recursive-union.js";
import { mapRecursiveUnionNorthStarVoyd } from "./fixtures/map-recursive-union-north-star.js";
import { CanonicalTypeTable } from "../semantics/types/canonical-type-table.js";
import { canonicalizeResolvedTypes } from "../semantics/types/canonicalize-resolved-types.js";
import { VoydModule } from "../syntax-objects/module.js";
import { Identifier } from "../syntax-objects/index.js";
import {
  TypeAlias,
  UnionType,
  ObjectType,
  Type,
} from "../syntax-objects/types.js";
import { Fn } from "../syntax-objects/fn.js";
import { Expr } from "../syntax-objects/expr.js";
import { Call } from "../syntax-objects/call.js";
import { typeKey } from "../semantics/types/type-key.js";
import { registerModules } from "../semantics/modules.js";
import { expandFunctionalMacros } from "../semantics/functional-macros.js";
import { initPrimitiveTypes } from "../semantics/init-primitive-types.js";
import { initEntities } from "../semantics/init-entities.js";
import { resolveEntities } from "../semantics/resolution/resolve-entities.js";
import { checkTypes } from "../semantics/check-types/index.js";
import { compile } from "../compiler.js";
import { codegen } from "../codegen.js";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";
import assert from "node:assert";
import fs from "node:fs";

type DedupeStats = {
  total: number;
  someCount: number;
};

type RecTypeSnapshot = {
  mapVariant?: ObjectType;
  mapVariantArg?: Type;
  mapCallType?: ObjectType;
  mapCallArg?: Type;
  mapVariantKey?: string;
  mapCallKey?: string;
};

const loadModuleWithoutCanonicalization = async (
  source: string = mapRecursiveUnionVoyd
): Promise<VoydModule> => {
  const parsedModule = await parseModule(source);
  const registered = registerModules(parsedModule);
  const resolved = [
    expandFunctionalMacros,
    initPrimitiveTypes,
    initEntities,
    resolveEntities,
  ].reduce((acc, phase) => phase(acc), registered as Expr);
  return checkTypes(resolved as VoydModule) as VoydModule;
};

const loadCanonicalizedModule = async (
  source: string = mapRecursiveUnionVoyd
): Promise<VoydModule> => {
  const parsedModule = await parseModule(source);
  return processSemantics(parsedModule) as VoydModule;
};

const analyzeDedupeStats = (root: VoydModule): DedupeStats => {
  const table = new CanonicalTypeTable({ recordEvents: true });
  canonicalizeResolvedTypes(root, { table });
  const events = table.getDedupeEvents();
  const someCount = events.reduce((count, event) => {
    const canonical = event.canonical as unknown as Record<string, unknown>;
    const name = (canonical as any)?.name?.toString?.();
    return name === "Some" ? count + 1 : count;
  }, 0);
  return {
    total: events.length,
    someCount,
  };
};

const collectCalls = (
  expr: Expr | undefined,
  result: Call[] = [],
  visited = new Set<Expr>()
): Call[] => {
  if (!expr || visited.has(expr)) return result;
  visited.add(expr);

  if (expr.isCall()) {
    const call = expr as Call;
    result.push(call);
    call.args.toArray().forEach((arg) => collectCalls(arg, result, visited));
    call.typeArgs
      ?.toArray()
      ?.forEach((arg) => collectCalls(arg, result, visited));
    if (call.fn?.isFn?.())
      collectCalls(call.fn as unknown as Expr, result, visited);
    return result;
  }

  if (expr.isBlock()) {
    expr.body.forEach((child) => collectCalls(child, result, visited));
    return result;
  }

  if (expr.isMatch()) {
    collectCalls(expr.operand, result, visited);
    expr.cases.forEach(({ expr: caseExpr, matchTypeExpr }) => {
      collectCalls(caseExpr, result, visited);
      if (matchTypeExpr) collectCalls(matchTypeExpr, result, visited);
    });
    if (expr.defaultCase) {
      collectCalls(expr.defaultCase.expr, result, visited);
      if (expr.defaultCase.matchTypeExpr)
        collectCalls(expr.defaultCase.matchTypeExpr, result, visited);
    }
    return result;
  }

  if (expr.isVariable()) {
    collectCalls(expr.initializer, result, visited);
    if (expr.typeExpr) collectCalls(expr.typeExpr, result, visited);
    return result;
  }

  if (expr.isArrayLiteral()) {
    expr.elements.forEach((element) => collectCalls(element, result, visited));
    return result;
  }

  if (expr.isObjectLiteral()) {
    expr.fields.forEach((field) =>
      collectCalls(field.initializer, result, visited)
    );
    return result;
  }

  if (expr.isFn()) {
    collectCalls(expr.body, result, visited);
    expr.parameters.forEach((param) => {
      if (param.typeExpr) collectCalls(param.typeExpr, result, visited);
    });
    expr.variables.forEach((variable) =>
      collectCalls(variable.initializer, result, visited)
    );
  }

  return result;
};

const captureRecTypeSnapshot = (root: VoydModule): RecTypeSnapshot => {
  const srcModule = root.resolveModule(Identifier.from("src")) as VoydModule;
  if (!srcModule) return {};

  const recAlias = srcModule.resolveEntity(Identifier.from("RecType")) as
    | TypeAlias
    | undefined;
  if (!recAlias?.type) return {};

  const recUnion = recAlias.type as UnionType;
  const mapVariant = recUnion.types.find(
    (type) =>
      type.isObjectType?.() &&
      ((type as ObjectType).genericParent?.name?.is("Map") ||
        (type as ObjectType).name?.is?.("Map"))
  ) as ObjectType | undefined;

  const makeMapFns = srcModule.resolveFns(Identifier.from("make_map")) as
    | Fn[]
    | undefined;
  const makeMap = makeMapFns?.[0];

  const mapCall = makeMap
    ? collectCalls(makeMap.body as Expr).find((call) => call.fnName.is("Map"))
    : undefined;

  return {
    mapVariant,
    mapVariantArg: mapVariant?.appliedTypeArgs?.[0],
    mapCallType: (mapCall?.type as ObjectType | undefined) ?? undefined,
    mapCallArg: ((mapCall?.type as ObjectType | undefined)?.appliedTypeArgs ??
      [])[0],
    mapVariantKey: mapVariant ? typeKey(mapVariant) : undefined,
    mapCallKey: mapCall?.type ? typeKey(mapCall.type) : undefined,
  };
};

const resolveTypeAlias = (
  root: VoydModule,
  name: string
): TypeAlias | undefined => {
  const srcModule = root.resolveModule(Identifier.from("src")) as
    | VoydModule
    | undefined;
  if (!srcModule) return undefined;
  return srcModule.resolveEntity(Identifier.from(name)) as
    | TypeAlias
    | undefined;
};

const collectWasmFunctionNames = (wasmText: string): string[] =>
  [...wasmText.matchAll(/\(func \$([^\s()]+)/g)].map(([, name]) => name);

const collectWasmTypeNames = (wasmText: string): string[] =>
  [...wasmText.matchAll(/\(type \$([^\s()]+)/g)].map(([, name]) => name);

type StructPayloadMap = Map<string, string>;

const collectStructPayloads = (
  wasmText: string,
  prefix: string
): StructPayloadMap => {
  const lines = wasmText.split(/\r?\n/);
  const payloads: StructPayloadMap = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(new RegExp(`\\(type \\$(${prefix}[^\\s()]*)`));
    if (!match) continue;
    const name = match[1];
    let depth = 0;
    const bodyLines: string[] = [];
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      const current = lines[cursor];
      bodyLines.push(current);
      for (const char of current) {
        if (char === "(") depth += 1;
        if (char === ")") depth -= 1;
      }
      if (depth === 0) {
        index = cursor;
        break;
      }
    }
    const bodyText = bodyLines.join(" ");
    const marker = "(field $value (mut ";
    const markerIndex = bodyText.indexOf(marker);
    if (markerIndex === -1) continue;
    let cursor = markerIndex + marker.length;
    let payloadDepth = 0;
    let payload = "";
    for (; cursor < bodyText.length; cursor += 1) {
      const char = bodyText[cursor];
      if (char === "(") {
        payloadDepth += 1;
        payload += char;
        continue;
      }
      if (char === ")") {
        if (payloadDepth === 0) break;
        payloadDepth -= 1;
        payload += char;
        continue;
      }
      payload += char;
    }
    if (payload) {
      payloads.set(name, payload.trim());
    }
  }
  return payloads;
};

const hasDuplicateSuffix = (name: string): boolean => /#\d+#\d+$/.test(name);

const isOptionalOrIteratorArtifact = (name: string): boolean =>
  name.startsWith("Some#") ||
  name.startsWith("None#") ||
  name.startsWith("iterate#");

describe("map-recursive-union canonicalization integration", () => {
  let wasmInstance: WebAssembly.Instance;
  let wasmText: string;

  beforeAll(async () => {
    const mod = await compile(mapRecursiveUnionVoyd);
    wasmInstance = getWasmInstance(mod);
    wasmText = mod.emitText();
  });

  test("manual canonicalization unwraps RecType alias and dedupes Map<RecType>", async (t) => {
    const root = await loadModuleWithoutCanonicalization();
    const before = captureRecTypeSnapshot(root);
    t.expect(before.mapVariantArg?.kindOfType).toBe("type-alias");

    const table = new CanonicalTypeTable({ recordEvents: true });
    canonicalizeResolvedTypes(root, { table });

    const after = captureRecTypeSnapshot(root);
    t.expect(after.mapVariantArg?.kindOfType).toBe("union");
    t.expect(table.getDedupeEvents().length).toBeGreaterThan(0);
    t.expect(
      table
        .getDedupeEvents()
        .some(
          (event) =>
            (event.canonical as ObjectType).name?.toString?.() === "Some"
        )
    ).toBe(true);
  });

  test("pipeline canonicalization reduces duplicate type fingerprints", async (t) => {
    const rootWithout = await loadModuleWithoutCanonicalization();
    const statsWithout = analyzeDedupeStats(rootWithout);

    const rootWith = await loadCanonicalizedModule();
    const statsWith = analyzeDedupeStats(rootWith);
    const snapshotWith = captureRecTypeSnapshot(rootWith);

    t.expect(statsWithout.total).toBeGreaterThan(statsWith.total);
    t.expect(statsWithout.total - statsWith.total).toBeGreaterThan(100);
    t.expect(statsWith.someCount).toBeGreaterThanOrEqual(1);
    t.expect(snapshotWith.mapVariantArg?.kindOfType).toBe("union");
    t.expect(snapshotWith.mapCallArg?.kindOfType).toBe("union");
    t.expect(snapshotWith.mapCallKey).toBe(snapshotWith.mapVariantKey);
  });

  test("wasm module executes main without trapping", (t) => {
    const main = getWasmFn("main", wasmInstance);
    assert(main, "main export should exist");
    t.expect(main()).toEqual(1);
  });

  test("wasm module emits a single Map struct", (t) => {
    const mapStructNames = [
      ...wasmText.matchAll(/\(type \$([^\s()]*Map[^\s()]*)/g),
    ]
      .map(([, name]) => name)
      .filter((name) => name.startsWith("Map#"));
    t.expect(new Set(mapStructNames).size).toBe(1);
    t.expect(mapStructNames).toMatchInlineSnapshot(`
      [
        "Map#146251#0",
      ]
    `);
  });

  test("wasm text instantiates Optional constructors once", (t) => {
    const someStructPayloads = collectStructPayloads(wasmText, "Some#");
    const payloadGroups = new Map<string, string[]>();
    someStructPayloads.forEach((payload, name) => {
      const existing = payloadGroups.get(payload);
      if (existing) {
        existing.push(name);
      } else {
        payloadGroups.set(payload, [name]);
      }
    });
    // Ensure each distinct payload shape is represented by exactly one struct.
    payloadGroups.forEach((names) => {
      t.expect(names.length).toBe(1);
    });

    const normalizedPayloads = new Set(
      [...someStructPayloads.values()].map((payload) =>
        payload.replace(/#\d+/g, "#<id>")
      )
    );
    t.expect([...normalizedPayloads].sort()).toEqual([
      "(ref null $Array#<id>#<id>)",
      "(ref null $Object#<id>)",
      "(ref null $String#<id>)",
      "i32",
    ]);

    const constructorRe = /struct\.(?:new(?:_with_rtt)?|new_default) \$([^\s()]+)/g;
    const counts = new Map<string, number>();
    let match: RegExpExecArray | null;
    while ((match = constructorRe.exec(wasmText))) {
      const name = match[1];
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }

    const someEntries = [...counts.entries()].filter(([name]) =>
      name.startsWith("Some#")
    );
    const noneEntries = [...counts.entries()].filter(([name]) =>
      name.startsWith("None#")
    );

    const uniqueSomeNames = new Set(someEntries.map(([name]) => name));
    const uniqueNoneNames = new Set(noneEntries.map(([name]) => name));
    const totalNoneCalls = noneEntries.reduce((total, [, count]) => total + count, 0);

    const structNames = new Set(someStructPayloads.keys());
    t.expect(uniqueSomeNames.size).toBe(structNames.size);
    uniqueSomeNames.forEach((name) => {
      t.expect(structNames.has(name)).toBe(true);
      t.expect((counts.get(name) ?? 0) > 0).toBe(true);
    });
    t.expect(uniqueNoneNames.size).toBe(1);
    const [noneStructName] = noneEntries[0] ?? [];
    if (noneStructName) {
      t.expect((counts.get(noneStructName) ?? 0) > 0).toBe(true);
    }
  });

  test("wasm text omits duplicated Optional helpers", (t) => {
    const functionNames = collectWasmFunctionNames(wasmText);
    const structNames = collectWasmTypeNames(wasmText);
    const duplicatedFunctions = functionNames.filter(
      (name) => isOptionalOrIteratorArtifact(name) && hasDuplicateSuffix(name)
    );
    const duplicatedStructs = structNames.filter(
      (name) => isOptionalOrIteratorArtifact(name) && hasDuplicateSuffix(name)
    );

    t.expect(duplicatedFunctions).toEqual([]);
    t.expect(duplicatedStructs).toEqual([]);
  });

  test("compiling map-recursive-union twice emits an identical wasm function set", async (t) => {
    const parsed = await parseModule(mapRecursiveUnionVoyd);
    const canonicalRoot = processSemantics(parsed) as VoydModule;
    const firstModule = codegen(canonicalRoot);
    const firstText = firstModule.emitText();
    firstModule.dispose?.();
    const secondModule = codegen(canonicalRoot);
    const secondText = secondModule.emitText();

    try {
      const firstFunctions = collectWasmFunctionNames(firstText).sort();
      const secondFunctions = collectWasmFunctionNames(secondText).sort();
      t.expect(secondFunctions).toEqual(firstFunctions);
      const extraFunctions = secondFunctions.filter(
        (name) =>
          isOptionalOrIteratorArtifact(name) && hasDuplicateSuffix(name)
      );
      t.expect(extraFunctions).toEqual([]);
    } finally {
      secondModule.dispose?.();
    }
  });

  describe("north-star recursive union regression (phase 2 fixtures)", () => {
    const wasmSnapshotPath = new URL(
      "./fixtures/snapshots/map-recursive-union-north-star.wat",
      import.meta.url
    );

    test.skip(
      "PHASE 7: canonical handles unify LeftNode and RightNode",
      async (t) => {
        const root = await loadModuleWithoutCanonicalization(
          mapRecursiveUnionNorthStarVoyd
        );
        const table = new CanonicalTypeTable({ recordEvents: true });
        canonicalizeResolvedTypes(root, { table });

        const leftAlias = resolveTypeAlias(root, "LeftNode");
        const rightAlias = resolveTypeAlias(root, "RightNode");

        t.expect(leftAlias?.type).toBeDefined();
        t.expect(rightAlias?.type).toBeDefined();
        // Phase 7 re-enable: LeftNode and RightNode should share the same canonical reference.
        t.expect(leftAlias?.type).toBe(rightAlias?.type);
      }
    );

    test.skip(
      "PHASE 7: wasm execution for the hybrid fixture returns 13",
      async (t) => {
        const module = await compile(mapRecursiveUnionNorthStarVoyd);
        try {
          const instance = getWasmInstance(module);
          const main = getWasmFn("main", instance);
          // Phase 7 re-enable: the hybrid fixture should execute without trapping and return 13.
          t.expect(main?.()).toEqual(13);
        } finally {
          module.dispose?.();
        }
      }
    );

    test.skip(
      "PHASE 7: optional constructors dedupe for the hybrid fixture",
      async (t) => {
        const module = await compile(mapRecursiveUnionNorthStarVoyd);
        try {
          const wasmText = module.emitText();
          const someStructPayloads = collectStructPayloads(
            wasmText,
            "Some#"
          );
          const payloadGroups = new Map<string, string[]>();
          someStructPayloads.forEach((payload, name) => {
            const existing = payloadGroups.get(payload);
            if (existing) {
              existing.push(name);
            } else {
              payloadGroups.set(payload, [name]);
            }
          });
          // Phase 7 re-enable: every Optional payload should collapse to a single struct.
          payloadGroups.forEach((names) => {
            t.expect(names.length).toBe(1);
          });
        } finally {
          module.dispose?.();
        }
      }
    );

    test.skip(
      "PHASE 7: union lowering matches the north-star wasm snapshot",
      async (t) => {
        const module = await compile(mapRecursiveUnionNorthStarVoyd);
        try {
          const wasmText = module.emitText();
          const somePayloads = collectStructPayloads(wasmText, "Some#");
          const mapPayloads = collectStructPayloads(wasmText, "Map#");
          const summaryLines: string[] = [];
          [...somePayloads.entries()]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .forEach(([name, payload]) => {
              summaryLines.push(`Some ${name} => ${payload}`);
            });
          [...mapPayloads.entries()]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .forEach(([name, payload]) => {
              summaryLines.push(`Map ${name} => ${payload}`);
            });
          const currentSummary = summaryLines.join("\n");
          const goldenSummary = await fs.promises.readFile(
            wasmSnapshotPath,
            "utf8"
          );
          // Phase 7 re-enable: wasm lowering should stabilize and match the captured snapshot.
          t.expect(currentSummary.trim()).toBe(goldenSummary.trim());
        } finally {
          module.dispose?.();
        }
      }
    );
  });
});
