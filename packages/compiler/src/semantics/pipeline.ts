import type { Form } from "../parser/index.js";
import { isForm } from "../parser/index.js";
import type { ModuleGraph, ModuleNode, ModulePath } from "../modules/types.js";
import { modulePathToString } from "../modules/path.js";
import { SymbolTable } from "./binder/index.js";
import { runBindingPipeline } from "./binding/binding.js";
import type { BindingResult, BoundOverloadSet } from "./binding/binding.js";
import { type HirGraph } from "./hir/index.js";
import {
  createHirBuilder,
  type HirVisibility,
  maxVisibility,
} from "./hir/index.js";
import { runLoweringPipeline } from "./lowering/lowering.js";
import { analyzeLambdaCaptures } from "./lowering/captures.js";
import { runTypingPipeline, type TypingResult } from "./typing/typing.js";
import { specializeOverloadCallees } from "./typing/specialize-overloads.js";
import { toSourceSpan } from "../parser/surface/utils.js";
import type { OverloadSetId, SourceSpan, SymbolId } from "./ids.js";
import type {
  ModuleExportEffect,
  ModuleExportEntry,
  ModuleExportSurfaceTable,
  ModuleExportTable,
} from "./modules.js";
import type { DependencySemantics } from "./typing/types.js";
import type { Diagnostic } from "../diagnostics/index.js";
import { DiagnosticError, diagnosticFromCode } from "../diagnostics/index.js";
import {
  buildModuleSymbolIndex,
  type ModuleSymbolIndex,
} from "./symbol-index.js";
import { getSymbolTable } from "./_internal/symbol-table.js";
import { assignModuleTestIds, isGeneratedTestId } from "../tests/ids.js";
import {
  markCompilerPerfPhaseDuration,
  startCompilerPerfPhase,
} from "../perf.js";
import { formatEffectRow } from "./effects/format.js";
import {
  analyzeBorrowing,
  emptyBorrowingResult,
  type BorrowingResult,
} from "./borrowing/index.js";
import {
  projectBorrowingDependencies,
  selectBorrowingDependencySemantics,
} from "./borrowing/dependency-projection.js";
export {
  createBorrowingDependencyProjectionCache,
  projectBorrowingDependencies,
  selectBorrowingDependencySemantics,
  snapshotBorrowingDependencyProjectionCacheStats,
  type BorrowingDependencyProjectionCache,
  type BorrowingDependencyProjectionCacheStats,
} from "./borrowing/dependency-projection.js";
import { buildPackageSemanticInterface } from "./package-borrow-interface.js";

export interface SemanticsPipelineResult {
  binding: BindingResult;
  symbols: ModuleSymbolIndex;
  hir: HirGraph;
  typing: TypingResult;
  borrowing: BorrowingResult;
  moduleId: string;
  exports: ModuleExportTable;
  diagnostics: readonly Diagnostic[];
}

export interface SemanticsPipelineOptions {
  module: ModuleNode;
  graph: ModuleGraph;
  exports?: Map<string, ModuleExportTable>;
  exportSurfaces?: Map<string, ModuleExportSurfaceTable>;
  dependencies?: Map<string, SemanticsPipelineResult>;
  typing?: Partial<Pick<TypingResult, "arena" | "effects">>;
  includeTests?: boolean;
  recoverFromTypingErrors?: boolean;
  checkBorrowBodies?: boolean;
}

export interface ReanalyzeSemanticsBorrowingOptions {
  semantics: SemanticsPipelineResult;
  module: ModuleNode;
  exports?: Map<string, ModuleExportTable>;
  dependencies?: Map<string, SemanticsPipelineResult>;
  recoverFromTypingErrors?: boolean;
}

type SemanticsPipelineInput = SemanticsPipelineOptions | Form;

export const semanticsPipeline = (
  input: SemanticsPipelineInput,
): SemanticsPipelineResult => {
  const {
    module,
    graph,
    exports,
    exportSurfaces,
    dependencies,
    typing: typingState,
    recoverFromTypingErrors,
    checkBorrowBodies,
  } = normalizeSemanticsInput(input);
  const form = module.ast;
  if (!form.callsInternal("ast")) {
    throw new Error("semantics pipeline expects the expanded AST root form");
  }

  assignModuleTestIds({ ast: form, modulePath: module.path });

  const symbolTable: SymbolTable = new SymbolTable({
    rootOwner: form.syntaxId,
  });
  const moduleSymbol = symbolTable.declare({
    name: module.id,
    kind: "module",
    declaredAt: form.syntaxId,
  });

  const binding = runBindingPipeline({
    moduleForm: form,
    symbolTable,
    module,
    graph,
    moduleExports: exports ?? new Map(),
    moduleExportSurfaces: exportSurfaces ?? new Map(),
    dependencies: dependencies
      ? new Map(
          Array.from(dependencies.entries()).map(([id, entry]) => [
            id,
            entry.binding,
          ]),
        )
      : undefined,
    includeTests: "includeTests" in input ? input.includeTests === true : false,
  });
  ensureNoBindingErrors(binding);

  const builder = createHirBuilder({
    path: module.id,
    scope: moduleSymbol,
    ast: form.syntaxId,
    span: toSourceSpan(form),
  });

  const hir = runLoweringPipeline({
    builder,
    binding,
    moduleNodeId: form.syntaxId,
    moduleId: module.id,
    modulePath: module.path,
    packageId: binding.packageId,
    isPackageRoot: binding.isPackageRoot,
  });
  analyzeLambdaCaptures({
    hir,
    symbolTable,
    scopeByNode: binding.scopeByNode,
  });

  let typing: TypingResult;
  try {
    typing = runTypingPipeline({
      symbolTable,
      hir,
      overloads: collectOverloadOptions(
        binding.overloads,
        binding.importedOverloadOptions,
      ),
      decls: binding.decls,
      arena: typingState?.arena,
      effects: typingState?.effects,
      imports: binding.imports,
      sourceImportLocals: binding.uses.flatMap((use) =>
        use.entries.flatMap((entry) =>
          entry.imports.map((entry) => entry.local),
        ),
      ),
      moduleId: module.id,
      packageId: binding.packageId,
      moduleExports: exports ?? new Map(),
      availableSemantics: projectDependencySemantics(dependencies),
      recoverDiagnosticErrors: recoverFromTypingErrors,
    });
  } catch (error) {
    if (error instanceof DiagnosticError) {
      throw new DiagnosticError(error.diagnostic, [
        ...binding.diagnostics,
        ...error.diagnostics,
      ]);
    }
    throw error;
  }

  specializeOverloadCallees({
    hir,
    typing,
    moduleId: module.id,
    imports: binding.imports,
  });
  return finalizeSemanticsPipeline({
    module,
    binding,
    symbolTable,
    hir,
    typing,
    exports,
    dependencies,
    recoverFromTypingErrors,
    checkBorrowBodies,
  });
};

/**
 * Reuses stabilized binding, lowering, and typing state while recomputing the
 * dependency-sensitive borrowing and export contracts for a cyclic module.
 */
export const reanalyzeSemanticsBorrowing = ({
  semantics,
  module,
  exports,
  dependencies,
  recoverFromTypingErrors,
}: ReanalyzeSemanticsBorrowingOptions): SemanticsPipelineResult => {
  const symbolTable = (
    semantics as SemanticsPipelineResult & { symbolTable?: SymbolTable }
  ).symbolTable;
  if (!symbolTable) {
    throw new Error("semantics result is missing its internal symbol table");
  }

  return finalizeSemanticsPipeline({
    module,
    binding: semantics.binding,
    symbolTable,
    hir: semantics.hir,
    typing: semantics.typing,
    exports,
    dependencies,
    recoverFromTypingErrors,
    checkBorrowBodies: true,
  });
};

const finalizeSemanticsPipeline = ({
  module,
  binding,
  symbolTable,
  hir,
  typing,
  exports,
  dependencies,
  recoverFromTypingErrors,
  checkBorrowBodies,
}: {
  module: ModuleNode;
  binding: BindingResult;
  symbolTable: SymbolTable;
  hir: HirGraph;
  typing: TypingResult;
  exports?: Map<string, ModuleExportTable>;
  dependencies?: Map<string, SemanticsPipelineResult>;
  recoverFromTypingErrors?: boolean;
  checkBorrowBodies?: boolean;
}): SemanticsPipelineResult => {
  const borrowingStartedAt = startCompilerPerfPhase();
  const borrowingDependencies = selectBorrowingDependencySemantics({
    dependencies,
    directDependencyModuleIds: module.dependencies.map((dependency) =>
      modulePathToString(dependency.path),
    ),
    importedModuleIds: [
      ...binding.imports.flatMap((entry) =>
        entry.target ? [entry.target.moduleId] : [],
      ),
      ...Array.from(typing.callTargets.values()).flatMap((targets) =>
        Array.from(targets.values(), (target) => target.moduleId),
      ),
      ...Array.from(typing.borrowCallTargets.values()).flatMap((targets) =>
        Array.from(targets.values(), (target) => target.moduleId),
      ),
    ],
  });
  const borrowing = typing.diagnostics.some(
    (diagnostic) => diagnostic.severity === "error",
  )
    ? emptyBorrowingResult()
    : analyzeBorrowing({
        hir,
        typing,
        symbolTable,
        moduleId: module.id,
        imports: binding.imports,
        dependencies: projectBorrowingDependencies(borrowingDependencies),
        decls: binding.decls,
        checkBodies: checkBorrowBodies,
      });
  markCompilerPerfPhaseDuration("analyzeBorrowing", borrowingStartedAt);
  const exportsTable = buildPackageSemanticInterface({
    moduleId: module.id,
    hir,
    symbolTable,
    typing,
    dependencyExports: exports ?? new Map(),
    exports: collectModuleExports({
      hir,
      symbolTable,
      moduleId: module.id,
      modulePath: module.path,
      packageId: binding.packageId,
      binding,
      typing,
      borrowing,
      dependencyExports: exports ?? new Map(),
    }),
  });

  const diagnostics: Diagnostic[] = [
    ...binding.diagnostics,
    ...typing.diagnostics,
    ...borrowing.diagnostics,
    ...enforcePkgRootEffectRules({ binding, hir, typing, symbolTable }),
  ];

  const borrowingErrors = borrowing.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  );
  if (!recoverFromTypingErrors && borrowingErrors.length > 0) {
    throw new DiagnosticError(borrowingErrors[0]!, diagnostics);
  }

  const symbols = buildModuleSymbolIndex({
    moduleId: module.id,
    packageId: binding.packageId,
    symbolTable,
  });

  return {
    binding,
    symbols,
    hir,
    typing,
    borrowing,
    moduleId: module.id,
    exports: exportsTable,
    diagnostics,
    // Intentionally not part of the public result type; semantics-internal only.
    ...({ symbolTable } as unknown as {}),
  } as SemanticsPipelineResult;
};

const ensureNoBindingErrors = (binding: BindingResult): void => {
  const errors = binding.diagnostics.filter(
    (diag) => diag.severity === "error",
  );
  if (errors.length === 0) {
    return;
  }
  throw new DiagnosticError(errors[0]!, binding.diagnostics);
};

const collectOverloadOptions = (
  overloads: ReadonlyMap<OverloadSetId, BoundOverloadSet>,
  imported?: ReadonlyMap<OverloadSetId, readonly SymbolId[]>,
): Map<OverloadSetId, readonly SymbolId[]> => {
  const entries = new Map<OverloadSetId, readonly SymbolId[]>(
    Array.from(overloads.entries()).map(([id, set]) => [
      id,
      set.functions.map((fn) => fn.symbol),
    ]),
  );
  if (imported) {
    imported.forEach((symbols, id) => {
      entries.set(id, symbols);
    });
  }
  return entries;
};

const collectModuleExports = ({
  hir,
  symbolTable,
  moduleId,
  modulePath,
  packageId,
  binding,
  typing,
  borrowing,
  dependencyExports,
}: {
  hir: HirGraph;
  symbolTable: SymbolTable;
  moduleId: string;
  modulePath: ModulePath;
  packageId: string;
  binding: BindingResult;
  typing: TypingResult;
  borrowing: BorrowingResult;
  dependencyExports: ReadonlyMap<string, ModuleExportTable>;
}): ModuleExportTable => {
  const table: ModuleExportTable = new Map();
  const imports = new Map(
    binding.imports.flatMap((entry) =>
      entry.target ? [[entry.local, entry.target] as const] : [],
    ),
  );
  const importedExportFor = (
    symbol: SymbolId,
  ): ModuleExportEntry | undefined => {
    const target = imports.get(symbol);
    if (!target) return undefined;
    return Array.from(
      dependencyExports.get(target.moduleId)?.values() ?? [],
    ).find(
      (entry) =>
        entry.symbol === target.symbol ||
        entry.symbols?.includes(target.symbol) === true,
    );
  };
  const mergeEffects = (
    existing: readonly ModuleExportEffect[] | undefined,
    next?: ModuleExportEffect,
  ): readonly ModuleExportEffect[] | undefined => {
    if (!next) return existing;
    const bySymbol = new Map(
      (existing ?? []).map((entry) => [entry.symbol, entry]),
    );
    bySymbol.set(next.symbol, next);
    return Array.from(bySymbol.values());
  };
  const exportEffectFor = (
    symbol: SymbolId,
  ): ModuleExportEffect | undefined => {
    const signature = typing.functions.getSignature(symbol);
    if (!signature) return undefined;
    const descriptor = typing.effects.getRow(
      signature.effectRow ?? typing.primitives.defaultEffectRow,
    );
    return {
      symbol,
      annotated: signature.annotatedEffects,
      operations: descriptor.operations.map((operation) => ({
        identity: { ...operation.identity },
        name: operation.name,
        ...(typeof operation.region === "number"
          ? { region: operation.region }
          : {}),
      })),
      ...(descriptor.tailVar
        ? { tail: { rigid: descriptor.tailVar.rigid } }
        : {}),
    };
  };
  const upsertExport = ({
    name,
    symbol,
    visibility,
    memberOwner,
    isStatic,
    apiProjection,
  }: {
    name: string;
    symbol: SymbolId;
    visibility: HirVisibility;
    memberOwner?: SymbolId;
    isStatic?: boolean;
    apiProjection?: boolean;
  }): void => {
    const existing = table.get(name);
    const symbols = new Set(
      existing?.symbols ?? (existing ? [existing.symbol] : []),
    );
    symbols.add(symbol);
    const overloadSet =
      existing && apiProjection === true
        ? existing.overloadSet
        : (binding.overloadBySymbol.get(symbol) ?? existing?.overloadSet);
    const record = symbolTable.getSymbol(symbol);
    const exportKind =
      existing && apiProjection === true
        ? existing.kind
        : existing &&
            existing.kind !== "effect-op" &&
            record.kind === "effect-op"
          ? existing.kind
          : record.kind;
    const primarySymbol =
      existing && existing.kind === exportKind ? existing.symbol : symbol;
    const memberSymbols = new Map(
      (existing?.memberSymbols ?? []).map((member) => [member.symbol, member]),
    );
    if (typeof memberOwner === "number") {
      memberSymbols.set(symbol, {
        symbol,
        owner: memberOwner,
        isStatic: isStatic === true,
      });
    }
    const ordinaryMutation = new Map(
      [
        ...(existing?.ordinaryMutation ?? []),
        ...(importedExportFor(symbol)?.ordinaryMutation?.map((entry) => ({
          ...entry,
          symbol,
        })) ?? []),
      ].map((entry) => [entry.symbol, entry]),
    );
    const defaultIdentityGuardProtocols = new Map(
      [
        ...(existing?.defaultIdentityGuardProtocols ?? []),
        ...(importedExportFor(symbol)?.defaultIdentityGuardProtocols?.map(
          (entry) => ({ ...entry, symbol }),
        ) ?? []),
      ].map((entry) => [entry.symbol, entry]),
    );
    const addDefaultIdentityGuardProtocol = (callable: SymbolId): void => {
      if (!borrowing.defaultIdentityGuardTargets.has(callable)) return;
      defaultIdentityGuardProtocols.set(callable, {
        symbol: callable,
        protocol: "presence-conflict-bit-v1",
      });
    };
    addDefaultIdentityGuardProtocol(symbol);
    const addOrdinaryMutationSummary = (callable: SymbolId): void => {
      const summary = borrowing.ordinaryMutationSummaries?.get(callable);
      if (!summary) return;
      ordinaryMutation.set(callable, {
        symbol: callable,
        summaryId: `${moduleId}:${callable}`,
        summary,
      });
    };
    addOrdinaryMutationSummary(symbol);
    const owner = Array.from(hir.items.values()).find(
      (item) =>
        (item.kind === "trait" || item.kind === "effect") &&
        item.symbol === symbol,
    );
    if (owner?.kind === "trait") {
      owner.methods.forEach((method) => {
        addOrdinaryMutationSummary(method.symbol);
        addDefaultIdentityGuardProtocol(method.symbol);
      });
    }
    if (owner?.kind === "effect") {
      owner.operations.forEach((operation) => {
        addOrdinaryMutationSummary(operation.symbol);
        addDefaultIdentityGuardProtocol(operation.symbol);
      });
    }
    const mergedVisibility = existing
      ? maxVisibility(existing.visibility, visibility)
      : visibility;
    table.set(name, {
      name,
      symbol: primarySymbol,
      symbols: Array.from(symbols),
      overloadSet,
      moduleId,
      modulePath,
      packageId,
      kind: exportKind,
      visibility: mergedVisibility,
      memberOwner: existing?.memberOwner ?? memberOwner,
      isStatic:
        existing?.isStatic === true ? true : (isStatic ?? existing?.isStatic),
      apiProjection: existing?.apiProjection || apiProjection === true,
      ...(memberSymbols.size > 0
        ? { memberSymbols: Array.from(memberSymbols.values()) }
        : {}),
      effects: mergeEffects(existing?.effects, exportEffectFor(symbol)),
      ordinaryMutation: Array.from(ordinaryMutation.values()),
      ...(defaultIdentityGuardProtocols.size > 0
        ? {
            defaultIdentityGuardProtocols: Array.from(
              defaultIdentityGuardProtocols.values(),
            ),
          }
        : {}),
    });
  };
  const memberInfoFor = (
    symbol: SymbolId,
  ): { owner?: SymbolId; isStatic?: boolean } => {
    const memberMetadata = typing.memberMetadata.get(symbol);
    const recordMetadata = symbolTable.getSymbol(symbol).metadata as
      | { static?: boolean }
      | undefined;
    return {
      ...(typeof memberMetadata?.owner === "number"
        ? { owner: memberMetadata.owner }
        : {}),
      ...(recordMetadata?.static === true ? { isStatic: true } : {}),
    };
  };

  hir.module.exports.forEach((entry) => {
    const record = symbolTable.getSymbol(entry.symbol);
    const { owner, isStatic } = memberInfoFor(entry.symbol);
    upsertExport({
      name: entry.alias ?? record.name,
      symbol: entry.symbol,
      visibility: entry.visibility,
      memberOwner: owner,
      isStatic,
    });
  });

  if (binding.isPackageRoot) {
    const exportedObjects = new Set(
      Array.from(table.values())
        .filter(
          (entry) =>
            entry.kind === "type" && entry.visibility.level === "public",
        )
        .map((entry) => entry.symbol),
    );
    typing.memberMetadata.forEach((metadata, symbol) => {
      if (!metadata.visibility?.api) return;
      if (typeof metadata.owner !== "number") return;
      if (!exportedObjects.has(metadata.owner)) return;
      const record = symbolTable.getSymbol(symbol);
      const visibility =
        metadata.visibility.level === "public"
          ? metadata.visibility
          : { ...metadata.visibility, level: "public" as const };
      upsertExport({
        name: record.name,
        symbol,
        visibility,
        memberOwner: metadata.owner,
        isStatic: memberInfoFor(symbol).isStatic,
        apiProjection: true,
      });
    });
  }
  return table;
};

const enforcePkgRootEffectRules = ({
  binding,
  hir,
  typing,
  symbolTable,
}: {
  binding: BindingResult;
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
}): Diagnostic[] => {
  if (!binding.isPackageRoot) {
    return [];
  }
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<SymbolId>();

  const getEffectInfo = (
    effectRow: number,
  ): { isPure: boolean; isPolymorphic: boolean; effectsText: string } => {
    try {
      const row = typing.effects.getRow(effectRow);
      const isPure = typing.effects.isEmpty(effectRow);
      const isPolymorphic =
        !isPure && row.operations.length === 0 && Boolean(row.tailVar);
      return {
        isPure,
        isPolymorphic,
        effectsText: formatEffectRow(effectRow, typing.effects),
      };
    } catch {
      return {
        isPure: false,
        isPolymorphic: false,
        effectsText: "unknown effects",
      };
    }
  };

  const checkExportedFunction = ({
    symbol,
    span,
    displayName,
  }: {
    symbol: SymbolId;
    span: SourceSpan;
    displayName: string;
  }): void => {
    if (isGeneratedTestId(displayName)) return;
    if (seen.has(symbol)) return;
    seen.add(symbol);

    const signature = typing.functions.getSignature(symbol);
    if (!signature) return;

    const { isPure, isPolymorphic, effectsText } = getEffectInfo(
      signature.effectRow,
    );

    if (
      !signature.annotatedEffects &&
      !isPure &&
      !isPolymorphic &&
      displayName !== "main"
    ) {
      diagnostics.push(
        diagnosticFromCode({
          code: "TY0016",
          params: {
            kind: "pkg-effect-annotation",
            functionName: displayName,
            effects: effectsText,
          },
          span,
        }),
      );
    }

    if (displayName === "main") {
      if (!isPure) {
        diagnostics.push(
          diagnosticFromCode({
            code: "TY0017",
            params: { kind: "effectful-main", effects: effectsText },
            span,
          }),
        );
      }
    }
  };

  hir.module.exports.forEach((entry) => {
    if (entry.visibility.level !== "public") return;
    const name = symbolTable.getSymbol(entry.symbol).name;
    checkExportedFunction({
      symbol: entry.symbol,
      span: entry.span,
      displayName: name,
    });
  });

  return diagnostics;
};

const projectDependencySemantics = (
  dependencies?: Map<string, SemanticsPipelineResult>,
): Map<string, DependencySemantics> => {
  if (!dependencies || dependencies.size === 0) {
    return new Map();
  }

  return new Map(
    Array.from(dependencies.entries()).map(([id, entry]) => [
      id,
      {
        moduleId: entry.moduleId,
        packageId: entry.binding.packageId,
        symbolTable: getSymbolTable(entry),
        hir: entry.hir,
        typing: entry.typing,
        decls: entry.binding.decls,
        overloads: collectOverloadOptions(entry.binding.overloads),
        exports: entry.exports,
        staticMethods: entry.binding.staticMethods,
      },
    ]),
  );
};

const normalizeSemanticsInput = (
  input: SemanticsPipelineInput,
): SemanticsPipelineOptions => {
  if (!isForm(input)) {
    return input;
  }

  const form = input;
  const id = form.location?.filePath ?? "<module>";
  const path: ModulePath = { namespace: "src", segments: [] };
  const module: ModuleNode = {
    id,
    path,
    origin: {
      kind: "file",
      filePath: id,
    },
    ast: form,
    source: "",
    dependencies: [],
  };

  const graph: ModuleGraph = {
    entry: module.id,
    modules: new Map([[module.id, module]]),
    diagnostics: [],
  };

  return {
    module,
    graph,
    exports: new Map(),
    dependencies: new Map(),
  };
};
