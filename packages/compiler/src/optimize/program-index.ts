import type { HirFunction, HirModuleLet } from "../semantics/hir/index.js";
import { walkExpression } from "../semantics/hir/index.js";
import type {
  ProgramCodegenView,
  SymbolRef,
} from "../semantics/codegen-view/index.js";
import type { HirExprId, ProgramSymbolId, SymbolId } from "../semantics/ids.js";
import type { OptimizedModuleView } from "./ir.js";

export type IndexedOptimizationFunction = {
  moduleId: string;
  symbol: SymbolId;
  item: HirFunction;
};

export type IndexedOptimizationModuleLet = {
  moduleId: string;
  symbol: SymbolId;
  item: HirModuleLet;
};

/**
 * HIR topology for one source body. The key deliberately excludes a function
 * instance: all generic instances share the same immutable HIR body topology.
 * Caller-specific call targets and type arguments belong in separate analyses.
 */
export type OptimizationBodyTopology = {
  moduleId: string;
  rootExprId: HirExprId;
  revision: number;
  postOrderExprIds: readonly HirExprId[];
  callSiteExprIds: readonly HirExprId[];
};

export type OptimizationBodyIndexCounters = {
  /** Number of body topologies materialized after a cache miss. */
  builds: number;
  /** Number of cached body topologies returned. */
  hits: number;
  /** Number of distinct HIR expressions visited while building topologies. */
  walks: number;
};

type ModuleStructureIndex = {
  functionsBySymbol: ReadonlyMap<SymbolId, IndexedOptimizationFunction>;
  moduleLetsBySymbol: ReadonlyMap<SymbolId, IndexedOptimizationModuleLet>;
  directImportsByLocal: ReadonlyMap<SymbolId, SymbolRef | undefined>;
  functionsByName: ReadonlyMap<string, readonly IndexedOptimizationFunction[]>;
  functionsByNameAndArity: ReadonlyMap<
    string,
    ReadonlyMap<number, readonly IndexedOptimizationFunction[]>
  >;
  functionRootsBySymbol: ReadonlyMap<SymbolId, readonly HirExprId[]>;
  moduleLetRootsBySymbol: ReadonlyMap<SymbolId, HirExprId>;
  rootExprIds: readonly HirExprId[];
};

type CachedBodyTopology = {
  revision: number;
  topology: OptimizationBodyTopology;
};

const append = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
  const values = map.get(key);
  if (values) {
    values.push(value);
    return;
  }
  map.set(key, [value]);
};

const freezeArrays = <K, V>(
  source: ReadonlyMap<K, readonly V[]>,
): ReadonlyMap<K, readonly V[]> =>
  new Map(
    Array.from(source, ([key, values]) => [key, Object.freeze([...values])]),
  );

const buildModuleStructureIndex = ({
  program,
  moduleView,
}: {
  program: ProgramCodegenView;
  moduleView: OptimizedModuleView;
}): ModuleStructureIndex => {
  const functionsBySymbol = new Map<SymbolId, IndexedOptimizationFunction>();
  const moduleLetsBySymbol = new Map<SymbolId, IndexedOptimizationModuleLet>();
  const directImportsByLocal = new Map<SymbolId, SymbolRef | undefined>();
  const functionsByName = new Map<string, IndexedOptimizationFunction[]>();
  const mutableFunctionsByNameAndArity = new Map<
    string,
    Map<number, IndexedOptimizationFunction[]>
  >();
  const functionRootsBySymbol = new Map<SymbolId, readonly HirExprId[]>();
  const moduleLetRootsBySymbol = new Map<SymbolId, HirExprId>();
  const rootExprIds: HirExprId[] = [];

  moduleView.meta.imports.forEach(({ local }) => {
    const target = program.imports.getTarget(moduleView.moduleId, local);
    directImportsByLocal.set(
      local,
      typeof target === "number" ? program.symbols.refOf(target) : undefined,
    );
  });

  moduleView.hir.items.forEach((item) => {
    if (item.kind === "function") {
      const indexed = {
        moduleId: moduleView.moduleId,
        symbol: item.symbol,
        item,
      } satisfies IndexedOptimizationFunction;
      functionsBySymbol.set(item.symbol, indexed);

      const functionRoots = Object.freeze([
        item.body,
        ...item.parameters.flatMap((parameter) =>
          typeof parameter.defaultValue === "number"
            ? [parameter.defaultValue]
            : [],
        ),
      ]);
      functionRootsBySymbol.set(item.symbol, functionRoots);
      rootExprIds.push(...functionRoots);

      const canonicalId = program.symbols.canonicalIdOf(
        moduleView.moduleId,
        item.symbol,
      ) as ProgramSymbolId;
      const name = program.symbols.getName(canonicalId);
      if (!name) {
        return;
      }
      append(functionsByName, name, indexed);

      const signature = program.functions.getSignature(
        moduleView.moduleId,
        item.symbol,
      );
      if (!signature) {
        return;
      }
      const byArity = mutableFunctionsByNameAndArity.get(name) ?? new Map();
      append(byArity, signature.parameters.length, indexed);
      mutableFunctionsByNameAndArity.set(name, byArity);
      return;
    }

    if (item.kind === "module-let") {
      const indexed = {
        moduleId: moduleView.moduleId,
        symbol: item.symbol,
        item,
      } satisfies IndexedOptimizationModuleLet;
      moduleLetsBySymbol.set(item.symbol, indexed);
      moduleLetRootsBySymbol.set(item.symbol, item.initializer);
      rootExprIds.push(item.initializer);
    }
  });

  return {
    functionsBySymbol,
    moduleLetsBySymbol,
    directImportsByLocal,
    functionsByName: freezeArrays(functionsByName),
    functionsByNameAndArity: new Map(
      Array.from(mutableFunctionsByNameAndArity, ([name, byArity]) => [
        name,
        freezeArrays(byArity),
      ]),
    ),
    functionRootsBySymbol,
    moduleLetRootsBySymbol,
    rootExprIds: Object.freeze(rootExprIds),
  };
};

/**
 * Optimizer-private indexes over the ProgramCodegenView boundary.
 *
 * Function, module-let, import, and root indexes describe immutable module
 * structure and are constructed once. Recreate this index if a pass changes
 * module items, function signatures, import wiring, or symbol metadata.
 *
 * Body topology is lazy because optimizer passes may rewrite expressions. A
 * caller must invoke `invalidateModuleTopology` after any expression or
 * statement mutation that can change reachable edges or an expression's call
 * kind. `invalidateAllBodyTopologies` is the conservative pass-level fallback.
 * Mutating caller-specific call resolution or type arguments does not require
 * invalidation: those facts are intentionally never cached here.
 */
export class ProgramOptimizationIndex {
  private readonly structureByModule: ReadonlyMap<string, ModuleStructureIndex>;
  private readonly resolvedImportsByModule = new Map<
    string,
    Map<SymbolId, SymbolRef>
  >();
  private readonly intrinsicFunctions = new Map<
    string,
    IndexedOptimizationFunction | undefined
  >();
  private readonly bodyTopologyByModule = new Map<
    string,
    Map<HirExprId, CachedBodyTopology>
  >();
  private readonly moduleRevisions = new Map<string, number>();
  private counters: OptimizationBodyIndexCounters = {
    builds: 0,
    hits: 0,
    walks: 0,
  };

  constructor(
    private readonly program: ProgramCodegenView,
    private readonly modules: ReadonlyMap<string, OptimizedModuleView>,
  ) {
    this.structureByModule = new Map(
      Array.from(modules, ([moduleId, moduleView]) => [
        moduleId,
        buildModuleStructureIndex({ program, moduleView }),
      ]),
    );
    modules.forEach((_module, moduleId) =>
      this.moduleRevisions.set(moduleId, 0),
    );
  }

  getFunction(
    moduleId: string,
    symbol: SymbolId,
  ): IndexedOptimizationFunction | undefined {
    return this.structureByModule.get(moduleId)?.functionsBySymbol.get(symbol);
  }

  getModuleLet(
    moduleId: string,
    symbol: SymbolId,
  ): IndexedOptimizationModuleLet | undefined {
    return this.structureByModule.get(moduleId)?.moduleLetsBySymbol.get(symbol);
  }

  isImportedSymbol(moduleId: string, symbol: SymbolId): boolean {
    return (
      this.structureByModule.get(moduleId)?.directImportsByLocal.has(symbol) ??
      false
    );
  }

  getDirectImport(moduleId: string, local: SymbolId): SymbolRef | undefined {
    return this.structureByModule
      .get(moduleId)
      ?.directImportsByLocal.get(local);
  }

  /** Resolves a local through transitive imports and caches the final symbol. */
  resolveImportedSymbol(moduleId: string, symbol: SymbolId): SymbolRef {
    const cached = this.resolvedImportsByModule.get(moduleId)?.get(symbol);
    if (cached) {
      return cached;
    }

    const visited: SymbolRef[] = [];
    const seenByModule = new Map<string, Set<SymbolId>>();
    let current = { moduleId, symbol } satisfies SymbolRef;
    let cycleDetected = false;

    while (true) {
      const seenSymbols = seenByModule.get(current.moduleId) ?? new Set();
      if (seenSymbols.has(current.symbol)) {
        cycleDetected = true;
        break;
      }
      seenSymbols.add(current.symbol);
      seenByModule.set(current.moduleId, seenSymbols);
      visited.push(current);

      const structure = this.structureByModule.get(current.moduleId);
      if (!structure?.directImportsByLocal.has(current.symbol)) {
        break;
      }
      const target = structure.directImportsByLocal.get(current.symbol);
      if (!target) {
        break;
      }
      current = target;
    }

    const result = Object.freeze({ ...current });
    const cacheableRefs = cycleDetected ? visited.slice(0, 1) : visited;
    cacheableRefs.forEach((ref) => {
      const bySymbol =
        this.resolvedImportsByModule.get(ref.moduleId) ?? new Map();
      bySymbol.set(ref.symbol, result);
      this.resolvedImportsByModule.set(ref.moduleId, bySymbol);
    });
    return result;
  }

  getFunctionsByName({
    moduleId,
    name,
    arity,
  }: {
    moduleId: string;
    name: string;
    arity?: number;
  }): readonly IndexedOptimizationFunction[] {
    const structure = this.structureByModule.get(moduleId);
    if (!structure) {
      return [];
    }
    return typeof arity === "number"
      ? (structure.functionsByNameAndArity.get(name)?.get(arity) ?? [])
      : (structure.functionsByName.get(name) ?? []);
  }

  /** Preserves the optimizer's source-order first-match overload behavior. */
  findFunctionSymbolByName({
    moduleId,
    name,
    arity,
  }: {
    moduleId: string;
    name: string;
    arity?: number;
  }): SymbolId | undefined {
    return this.getFunctionsByName({ moduleId, name, arity })[0]?.symbol;
  }

  /**
   * Lazily locates an intrinsic. Distinct declarations with the same intrinsic
   * name are rejected, matching the optimizer's dependency lookup contract.
   */
  resolveIntrinsicFunction(
    intrinsicName: string,
  ): IndexedOptimizationFunction | undefined {
    if (this.intrinsicFunctions.has(intrinsicName)) {
      return this.intrinsicFunctions.get(intrinsicName);
    }

    let match: IndexedOptimizationFunction | undefined;
    this.structureByModule.forEach((structure) => {
      structure.functionsBySymbol.forEach((candidate) => {
        const canonicalId = this.program.symbols.canonicalIdOf(
          candidate.moduleId,
          candidate.symbol,
        ) as ProgramSymbolId;
        if (
          this.program.symbols.getIntrinsicName(canonicalId) !== intrinsicName
        ) {
          return;
        }
        if (
          match &&
          (match.moduleId !== candidate.moduleId ||
            match.symbol !== candidate.symbol)
        ) {
          throw new Error(
            `ambiguous optimizer function dependency ${intrinsicName}`,
          );
        }
        match = candidate;
      });
    });

    this.intrinsicFunctions.set(intrinsicName, match);
    return match;
  }

  getFunctionBodyRootExprId(
    moduleId: string,
    symbol: SymbolId,
  ): HirExprId | undefined {
    return this.getFunction(moduleId, symbol)?.item.body;
  }

  getFunctionRootExprIds(
    moduleId: string,
    symbol: SymbolId,
  ): readonly HirExprId[] {
    return (
      this.structureByModule.get(moduleId)?.functionRootsBySymbol.get(symbol) ??
      []
    );
  }

  getModuleLetRootExprId(
    moduleId: string,
    symbol: SymbolId,
  ): HirExprId | undefined {
    return this.structureByModule
      .get(moduleId)
      ?.moduleLetRootsBySymbol.get(symbol);
  }

  getModuleRootExprIds(moduleId: string): readonly HirExprId[] {
    return this.structureByModule.get(moduleId)?.rootExprIds ?? [];
  }

  getModuleRevision(moduleId: string): number {
    return this.moduleRevisions.get(moduleId) ?? 0;
  }

  getBodyTopology({
    moduleId,
    rootExprId,
  }: {
    moduleId: string;
    rootExprId: HirExprId;
  }): OptimizationBodyTopology {
    const moduleView = this.modules.get(moduleId);
    if (!moduleView) {
      throw new Error(`missing optimizer module ${moduleId}`);
    }
    const revision = this.getModuleRevision(moduleId);
    const cached = this.bodyTopologyByModule.get(moduleId)?.get(rootExprId);
    if (cached?.revision === revision) {
      this.counters.hits += 1;
      return cached.topology;
    }

    const visited = new Set<HirExprId>();
    const preOrderExprIds: HirExprId[] = [];
    const callSiteExprIds: HirExprId[] = [];
    walkExpression({
      exprId: rootExprId,
      hir: moduleView.hir,
      onEnterExpression: (exprId, expression) => {
        if (visited.has(exprId)) {
          return { skipChildren: true };
        }
        visited.add(exprId);
        this.counters.walks += 1;
        preOrderExprIds.push(exprId);
        if (
          expression.exprKind === "call" ||
          expression.exprKind === "method-call"
        ) {
          callSiteExprIds.push(exprId);
        }
      },
    });
    // Reverse preorder is a valid child-before-parent order and preserves the
    // optimizer's established sibling processing order.
    const postOrderExprIds = preOrderExprIds.reverse();
    callSiteExprIds.reverse();

    const topology = Object.freeze({
      moduleId,
      rootExprId,
      revision,
      postOrderExprIds: Object.freeze(postOrderExprIds),
      callSiteExprIds: Object.freeze(callSiteExprIds),
    }) satisfies OptimizationBodyTopology;
    const byRoot = this.bodyTopologyByModule.get(moduleId) ?? new Map();
    byRoot.set(rootExprId, { revision, topology });
    this.bodyTopologyByModule.set(moduleId, byRoot);
    this.counters.builds += 1;
    return topology;
  }

  /** Invalidates lazy body topology for one module after a HIR mutation. */
  invalidateModuleTopology(moduleId: string): void {
    this.moduleRevisions.set(moduleId, this.getModuleRevision(moduleId) + 1);
    this.bodyTopologyByModule.delete(moduleId);
  }

  /** Conservatively invalidates all lazy body topology after a mutating pass. */
  invalidateAllBodyTopologies(): void {
    this.modules.forEach((_module, moduleId) =>
      this.invalidateModuleTopology(moduleId),
    );
  }

  getBodyIndexCounters(): OptimizationBodyIndexCounters {
    return { ...this.counters };
  }

  resetBodyIndexCounters(): void {
    this.counters = { builds: 0, hits: 0, walks: 0 };
  }
}
