import { describe, expect, it } from "vitest";
import {
  createHirBuilder,
  publicVisibility,
} from "../../semantics/hir/index.js";
import type { ProgramCodegenView } from "../../semantics/codegen-view/index.js";
import type { ProgramSymbolId, SymbolId } from "../../semantics/ids.js";
import type { OptimizedModuleView } from "../ir.js";
import { ProgramOptimizationIndex } from "../program-index.js";

const span = { file: "program-index.test.voyd", start: 0, end: 1 };

type ModuleFixture = {
  view: OptimizedModuleView;
  functionSymbol: SymbolId;
  bodyRoot: number;
  moduleLetSymbol: SymbolId;
  moduleLetRoot: number;
  defaultRoot?: number;
};

const createModuleFixture = ({
  moduleId,
  functionSymbol,
  moduleLetSymbol,
  imports = [],
  withCallBody = false,
  withDefault = false,
}: {
  moduleId: string;
  functionSymbol: SymbolId;
  moduleLetSymbol: SymbolId;
  imports?: readonly SymbolId[];
  withCallBody?: boolean;
  withDefault?: boolean;
}): ModuleFixture => {
  const builder = createHirBuilder({
    path: moduleId,
    scope: 0,
    ast: 1,
    span,
  });
  const callee = builder.addExpression({
    kind: "expr",
    exprKind: "identifier",
    ast: 2,
    span,
    symbol: 900,
  });
  const argument = builder.addExpression({
    kind: "expr",
    exprKind: "literal",
    ast: 3,
    span,
    literalKind: "i32",
    value: "1",
  });
  const bodyRoot = withCallBody
    ? builder.addExpression({
        kind: "expr",
        exprKind: "call",
        ast: 4,
        span,
        callee,
        args: [{ expr: argument }],
      })
    : argument;
  const defaultRoot = withDefault
    ? builder.addExpression({
        kind: "expr",
        exprKind: "literal",
        ast: 5,
        span,
        literalKind: "i32",
        value: "2",
      })
    : undefined;
  builder.addFunction({
    kind: "function",
    visibility: publicVisibility(),
    symbol: functionSymbol,
    ast: 6,
    span,
    parameters:
      typeof defaultRoot === "number"
        ? [
            {
              symbol: functionSymbol + 1,
              pattern: {
                kind: "identifier",
                symbol: functionSymbol + 1,
              },
              span,
              mutable: false,
              defaultValue: defaultRoot,
            },
          ]
        : [],
    body: bodyRoot,
  });
  const moduleLetRoot = builder.addExpression({
    kind: "expr",
    exprKind: "literal",
    ast: 7,
    span,
    literalKind: "i32",
    value: "3",
  });
  builder.addItem({
    kind: "module-let",
    visibility: publicVisibility(),
    symbol: moduleLetSymbol,
    ast: 8,
    span,
    initializer: moduleLetRoot,
  });

  return {
    view: {
      moduleId,
      meta: {
        moduleId,
        packageId: "test",
        isPackageRoot: false,
        imports: imports.map((local) => ({ local })),
        effects: [],
      },
      hir: builder.finalize(),
    } as unknown as OptimizedModuleView,
    functionSymbol,
    bodyRoot,
    moduleLetSymbol,
    moduleLetRoot,
    defaultRoot,
  };
};

type SymbolFixture = {
  moduleId: string;
  symbol: SymbolId;
  name?: string;
  intrinsicName?: string;
};

const createProgram = ({
  modules,
  symbols,
  importTargets = new Map(),
  onIntrinsicLookup,
}: {
  modules: ReadonlyMap<string, OptimizedModuleView>;
  symbols: readonly SymbolFixture[];
  importTargets?: ReadonlyMap<string, ProgramSymbolId>;
  onIntrinsicLookup?: () => void;
}): ProgramCodegenView => {
  const idsByRef = new Map<string, ProgramSymbolId>();
  const refsById = new Map<ProgramSymbolId, SymbolFixture>();
  symbols.forEach((symbol, index) => {
    const id = index as ProgramSymbolId;
    idsByRef.set(`${symbol.moduleId}:${symbol.symbol}`, id);
    refsById.set(id, symbol);
  });
  const idOf = (moduleId: string, symbol: SymbolId): ProgramSymbolId => {
    const id = idsByRef.get(`${moduleId}:${symbol}`);
    if (typeof id !== "number") {
      throw new Error(`missing test symbol ${moduleId}:${symbol}`);
    }
    return id;
  };

  return {
    symbols: {
      canonicalIdOf: idOf,
      refOf: (id: ProgramSymbolId) => {
        const symbol = refsById.get(id);
        if (!symbol) {
          throw new Error(`missing test ProgramSymbolId ${id}`);
        }
        return { moduleId: symbol.moduleId, symbol: symbol.symbol };
      },
      getName: (id: ProgramSymbolId) => refsById.get(id)?.name,
      getIntrinsicName: (id: ProgramSymbolId) => {
        onIntrinsicLookup?.();
        return refsById.get(id)?.intrinsicName;
      },
    },
    functions: {
      getSignature: (moduleId: string, symbol: SymbolId) => {
        const item = modules
          .get(moduleId)
          ?.hir.items.values()
          .find(
            (candidate) =>
              candidate.kind === "function" && candidate.symbol === symbol,
          );
        if (item?.kind !== "function") {
          return undefined;
        }
        return {
          parameters: item.parameters.map(() => ({})),
        };
      },
    },
    imports: {
      getTarget: (moduleId: string, local: SymbolId) =>
        importTargets.get(`${moduleId}:${local}`),
    },
  } as unknown as ProgramCodegenView;
};

const createFixture = ({ duplicateIntrinsic = false } = {}) => {
  const a = createModuleFixture({
    moduleId: "a",
    functionSymbol: 10,
    moduleLetSymbol: 20,
    imports: [50],
    withCallBody: true,
    withDefault: true,
  });
  const b = createModuleFixture({
    moduleId: "b",
    functionSymbol: 30,
    moduleLetSymbol: 40,
    imports: [60],
  });
  const c = createModuleFixture({
    moduleId: "c",
    functionSymbol: 70,
    moduleLetSymbol: 80,
  });
  const modules = new Map([
    ["a", a.view],
    ["b", b.view],
    ["c", c.view],
  ]);
  const symbols = [
    { moduleId: "a", symbol: 10, name: "compute" },
    { moduleId: "b", symbol: 30, name: "helper" },
    { moduleId: "b", symbol: 60 },
    {
      moduleId: "c",
      symbol: 70,
      name: "runtime_helper",
      intrinsicName: "__runtime_helper",
    },
  ] satisfies SymbolFixture[];
  if (duplicateIntrinsic) {
    symbols[1]!.intrinsicName = "__runtime_helper";
  }
  const ids = new Map(
    symbols.map((symbol, index) => [
      `${symbol.moduleId}:${symbol.symbol}`,
      index as ProgramSymbolId,
    ]),
  );
  const importTargets = new Map([
    ["a:50", ids.get("b:60")!],
    ["b:60", ids.get("c:70")!],
  ]);
  return { a, b, c, modules, symbols, importTargets };
};

describe("ProgramOptimizationIndex", () => {
  it("indexes functions, module lets, names, imports, and source roots", () => {
    const fixture = createFixture();
    const index = new ProgramOptimizationIndex(
      createProgram(fixture),
      fixture.modules,
    );

    expect(index.getFunction("a", fixture.a.functionSymbol)?.item.symbol).toBe(
      fixture.a.functionSymbol,
    );
    expect(
      index.getModuleLet("a", fixture.a.moduleLetSymbol)?.item.symbol,
    ).toBe(fixture.a.moduleLetSymbol);
    expect(
      index.findFunctionSymbolByName({
        moduleId: "a",
        name: "compute",
        arity: 1,
      }),
    ).toBe(fixture.a.functionSymbol);
    expect(
      index.findFunctionSymbolByName({
        moduleId: "a",
        name: "compute",
        arity: 0,
      }),
    ).toBeUndefined();
    expect(index.isImportedSymbol("a", 50)).toBe(true);
    expect(index.getDirectImport("a", 50)).toEqual({
      moduleId: "b",
      symbol: 60,
    });
    expect(index.getFunctionRootExprIds("a", fixture.a.functionSymbol)).toEqual(
      [fixture.a.bodyRoot, fixture.a.defaultRoot],
    );
    expect(index.getModuleRootExprIds("a")).toEqual([
      fixture.a.bodyRoot,
      fixture.a.defaultRoot,
      fixture.a.moduleLetRoot,
    ]);
  });

  it("caches transitive import resolution", () => {
    const fixture = createFixture();
    const index = new ProgramOptimizationIndex(
      createProgram(fixture),
      fixture.modules,
    );

    const resolved = index.resolveImportedSymbol("a", 50);
    expect(resolved).toEqual({ moduleId: "c", symbol: 70 });
    expect(index.resolveImportedSymbol("a", 50)).toBe(resolved);
    expect(index.resolveImportedSymbol("b", 60)).toBe(resolved);
  });

  it("lazily caches intrinsic lookup and rejects ambiguity", () => {
    const fixture = createFixture();
    let lookups = 0;
    const index = new ProgramOptimizationIndex(
      createProgram({ ...fixture, onIntrinsicLookup: () => (lookups += 1) }),
      fixture.modules,
    );

    expect(index.resolveIntrinsicFunction("__runtime_helper")?.symbol).toBe(70);
    const lookupsAfterBuild = lookups;
    expect(index.resolveIntrinsicFunction("__runtime_helper")?.symbol).toBe(70);
    expect(lookups).toBe(lookupsAfterBuild);

    const ambiguous = createFixture({ duplicateIntrinsic: true });
    const ambiguousIndex = new ProgramOptimizationIndex(
      createProgram(ambiguous),
      ambiguous.modules,
    );
    expect(() =>
      ambiguousIndex.resolveIntrinsicFunction("__runtime_helper"),
    ).toThrow("ambiguous optimizer function dependency __runtime_helper");
  });

  it("shares lazy body topology until explicit module invalidation", () => {
    const fixture = createFixture();
    const index = new ProgramOptimizationIndex(
      createProgram(fixture),
      fixture.modules,
    );
    const first = index.getBodyTopology({
      moduleId: "a",
      rootExprId: fixture.a.bodyRoot,
    });
    const cached = index.getBodyTopology({
      moduleId: "a",
      rootExprId: fixture.a.bodyRoot,
    });
    const unrelated = index.getBodyTopology({
      moduleId: "b",
      rootExprId: fixture.b.bodyRoot,
    });

    expect(cached).toBe(first);
    expect(first.postOrderExprIds).toHaveLength(3);
    expect(first.postOrderExprIds.at(-1)).toBe(fixture.a.bodyRoot);
    expect(first.callSiteExprIds).toEqual([fixture.a.bodyRoot]);
    expect(index.getBodyIndexCounters()).toEqual({
      builds: 2,
      hits: 1,
      walks: 4,
    });

    const expressions = fixture.a.view.hir.expressions as Map<
      number,
      typeof fixture.a.view.hir.expressions extends ReadonlyMap<number, infer T>
        ? T
        : never
    >;
    expressions.set(fixture.a.bodyRoot, {
      kind: "expr",
      exprKind: "literal",
      id: fixture.a.bodyRoot,
      ast: 9,
      span,
      literalKind: "i32",
      value: "4",
    });
    index.invalidateModuleTopology("a");

    expect(
      index.getBodyTopology({
        moduleId: "b",
        rootExprId: fixture.b.bodyRoot,
      }),
    ).toBe(unrelated);

    const rebuilt = index.getBodyTopology({
      moduleId: "a",
      rootExprId: fixture.a.bodyRoot,
    });
    expect(rebuilt.revision).toBe(1);
    expect(rebuilt.postOrderExprIds).toEqual([fixture.a.bodyRoot]);
    expect(rebuilt.callSiteExprIds).toEqual([]);
    expect(index.getBodyIndexCounters()).toEqual({
      builds: 3,
      hits: 2,
      walks: 5,
    });
  });
});
