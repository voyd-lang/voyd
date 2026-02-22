import binaryen from "binaryen";
import { describe, expect, it } from "vitest";
import type { CodegenContext, FunctionMetadata } from "../context.js";
import {
  markDependencyFunctionReachable,
  requireDependencyFunctionMeta,
} from "../function-dependencies.js";
import { createTestCodegenContext } from "./support/test-codegen-context.js";
import type {
  ProgramFunctionInstanceId,
  ProgramSymbolId,
  SymbolId,
  TypeId,
} from "../../semantics/ids.js";

type DependencyFunctionConfig = {
  programSymbolId: ProgramSymbolId;
  moduleId: string;
  symbol: SymbolId;
  intrinsicName?: string;
  metadata?: FunctionMetadata;
};

const createDependencyContext = (
  configs: readonly DependencyFunctionConfig[],
): CodegenContext => {
  const { ctx } = createTestCodegenContext();
  const moduleIds = new Set(configs.map((config) => config.moduleId));
  const moduleEntries = Array.from(moduleIds).map((moduleId) => {
    const items = new Map();
    configs
      .filter((config) => config.moduleId === moduleId)
      .forEach((config) => {
        items.set(config.symbol, {
          kind: "function",
          symbol: config.symbol,
        });
      });
    return [
      moduleId,
      {
        moduleId,
        meta: {
          moduleId,
          packageId: "test",
          isPackageRoot: true,
          imports: [],
          effects: [],
        },
        hir: {
          items,
          expressions: new Map(),
        },
        effects: { isEmpty: () => true, getRow: () => ({ operations: [] }) },
        types: {
          getExprType: () => 0,
          getResolvedExprType: () => undefined,
          getValueType: () => undefined,
          getTailResumption: () => undefined,
        },
        effectsInfo: {
          functions: new Map(),
          operations: new Map(),
          handlers: new Map(),
          calls: new Map(),
          handlerTails: new Map(),
          lambdas: new Map(),
        },
      },
    ] as const;
  });
  ctx.program.modules = new Map(moduleEntries) as any;

  const idByRef = new Map<string, ProgramSymbolId>();
  const refById = new Map<
    ProgramSymbolId,
    {
      moduleId: string;
      symbol: SymbolId;
    }
  >();
  const intrinsicById = new Map<ProgramSymbolId, string | undefined>();
  configs.forEach((config) => {
    idByRef.set(
      `${config.moduleId}:${config.symbol}`,
      config.programSymbolId,
    );
    refById.set(config.programSymbolId, {
      moduleId: config.moduleId,
      symbol: config.symbol,
    });
    intrinsicById.set(config.programSymbolId, config.intrinsicName);
  });

  ctx.program.symbols = {
    ...ctx.program.symbols,
    canonicalIdOf: (moduleId: string, symbol: SymbolId) => {
      const id = idByRef.get(`${moduleId}:${symbol}`);
      if (typeof id !== "number") {
        throw new Error(`unknown symbol ${moduleId}::${symbol}`);
      }
      return id;
    },
    refOf: (id: ProgramSymbolId) => {
      const ref = refById.get(id);
      if (!ref) {
        throw new Error(`unknown ProgramSymbolId ${id}`);
      }
      return ref;
    },
    getIntrinsicName: (id: ProgramSymbolId) => intrinsicById.get(id),
  } as any;

  const functions = new Map<string, Map<number, FunctionMetadata[]>>();
  configs.forEach((config) => {
    if (!config.metadata) {
      return;
    }
    const bySymbol = functions.get(config.moduleId) ?? new Map();
    bySymbol.set(config.symbol, [config.metadata]);
    functions.set(config.moduleId, bySymbol);
  });
  ctx.functions = functions;

  return ctx;
};

const functionMetaFor = ({
  moduleId,
  symbol,
  wasmName,
}: {
  moduleId: string;
  symbol: SymbolId;
  wasmName: string;
}): FunctionMetadata => ({
  moduleId,
  symbol,
  wasmName,
  paramTypes: [binaryen.i32],
  resultType: binaryen.i32,
  paramTypeIds: [1 as TypeId],
  parameters: [{ typeId: 1 as TypeId }],
  resultTypeId: 1 as TypeId,
  typeArgs: [],
  instanceId: 1 as ProgramFunctionInstanceId,
  effectful: false,
});

describe("function dependency resolution", () => {
  it("resolves string literal constructor by intrinsic metadata", () => {
    const moduleId = "custom::text";
    const symbol = 7 as SymbolId;
    const programSymbolId = 101 as ProgramSymbolId;
    const meta = functionMetaFor({
      moduleId,
      symbol,
      wasmName: "__custom_string_new",
    });
    const ctx = createDependencyContext([
      {
        programSymbolId,
        moduleId,
        symbol,
        intrinsicName: "__string_new",
        metadata: meta,
      },
    ]);

    const reachable = new Set<ProgramSymbolId>();
    markDependencyFunctionReachable({
      ctx,
      dependency: "string-literal-constructor",
      reachable,
    });
    expect(reachable.has(programSymbolId)).toBe(true);
    expect(
      requireDependencyFunctionMeta({
        ctx,
        dependency: "string-literal-constructor",
      }),
    ).toBe(meta);
  });

  it("throws when the string literal constructor dependency is missing", () => {
    const ctx = createDependencyContext([
      {
        programSymbolId: 100 as ProgramSymbolId,
        moduleId: "custom::text",
        symbol: 3 as SymbolId,
      },
    ]);

    expect(() =>
      requireDependencyFunctionMeta({
        ctx,
        dependency: "string-literal-constructor",
      }),
    ).toThrow(/missing codegen function dependency string-literal-constructor/);
  });

  it("throws when multiple functions claim the string literal constructor dependency", () => {
    const ctx = createDependencyContext([
      {
        programSymbolId: 100 as ProgramSymbolId,
        moduleId: "custom::text_a",
        symbol: 3 as SymbolId,
        intrinsicName: "__string_new",
      },
      {
        programSymbolId: 101 as ProgramSymbolId,
        moduleId: "custom::text_b",
        symbol: 4 as SymbolId,
        intrinsicName: "__string_new",
      },
    ]);

    expect(() =>
      requireDependencyFunctionMeta({
        ctx,
        dependency: "string-literal-constructor",
      }),
    ).toThrow(/ambiguous codegen function dependency string-literal-constructor/);
  });
});
