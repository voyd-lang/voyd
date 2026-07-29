import type { Form } from "../parser/index.js";
import { isForm } from "../parser/index.js";
import type { ModuleGraph, ModuleNode, ModulePath } from "../modules/types.js";
import { SymbolTable } from "./binder/index.js";
import { runBindingPipeline } from "./binding/binding.js";
import type { BindingResult, BoundOverloadSet } from "./binding/binding.js";
import type { HirGraph } from "./hir/index.js";
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
  callableBorrowSummarySize,
  deserializeCallableBorrowSummary,
  emptyBorrowingResult,
  serializeCallableBorrowSummary,
  type BorrowingDependency,
  type BorrowingResult,
  type CallableBorrowSummaryPrivacy,
  type CallableBorrowSummarySource,
  type PlaceProjection,
} from "./borrowing/index.js";

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
  const borrowingStartedAt = startCompilerPerfPhase();
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
        dependencies: projectBorrowingDependencies(dependencies),
        decls: binding.decls,
      });
  markCompilerPerfPhaseDuration("analyzeBorrowing", borrowingStartedAt);
  const exportsTable = collectModuleExports({
    hir,
    symbolTable,
    moduleId: module.id,
    modulePath: module.path,
    packageId: binding.packageId,
    binding,
    typing,
    borrowing,
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

const projectBorrowingDependencies = (
  dependencies: ReadonlyMap<string, SemanticsPipelineResult> | undefined,
): ReadonlyMap<string, BorrowingDependency> =>
  new Map(
    Array.from(dependencies ?? [], ([moduleId, semantics]) => {
      const dependencySymbols = getSymbolTable(semantics);
      const exportedBorrowing = new Map(
        Array.from(semantics.exports.values()).flatMap(
          (entry) =>
            entry.borrowing?.map((borrow) => {
              const summary = borrow.serialized
                ? deserializeCallableBorrowSummary(borrow.serialized)
                : {
                    dispatch: "ordinary" as const,
                    contract: borrow.contract,
                    namedContract: undefined,
                    source: undefined,
                  };
              return [
                borrow.symbol,
                {
                  contract: summary.contract,
                  dispatch: summary.dispatch,
                  namedContract: summary.namedContract,
                  source: summary.source,
                },
              ] as const;
            }) ?? [],
        ),
      );
      const effectSymbols = new Set(
        Array.from(semantics.exports.values()).flatMap(
          (entry) => entry.effects?.map((effect) => effect.symbol) ?? [],
        ),
      );
      const callableSymbols = new Set([
        ...exportedBorrowing.keys(),
        ...effectSymbols,
      ]);
      const callables = new Map(
        Array.from(callableSymbols, (symbol) => [
          symbol,
          {
            name: dependencySymbols.getSymbol(symbol).name,
            signature: semantics.typing.functions.getSignature(symbol),
            contract: exportedBorrowing.get(symbol)?.contract,
            dispatch: exportedBorrowing.get(symbol)?.dispatch,
            namedContract: exportedBorrowing.get(symbol)?.namedContract,
            source: exportedBorrowing.get(symbol)?.source,
          },
        ]),
      );
      const effectOperations = new Map(
        Array.from(effectSymbols).flatMap((symbol) => {
          const operation = semantics.binding.decls.getEffectOperation(symbol);
          return operation
            ? [
                [
                  symbol,
                  {
                    maySuspend: operation.operation.resumable === "resume",
                  },
                ] as const,
              ]
            : [];
        }),
      );
      return [moduleId, { callables, effectOperations }] as const;
    }),
  );

const callableBorrowSummarySources = (
  hir: HirGraph,
  moduleId: string,
): ReadonlyMap<SymbolId, CallableBorrowSummarySource> => {
  const stableSpan = (span: SourceSpan) => ({
    moduleId,
    start: span.start,
    end: span.end,
  });
  const sources = new Map<SymbolId, CallableBorrowSummarySource>();
  for (const item of hir.items.values()) {
    if (item.kind === "function") {
      sources.set(item.symbol, {
        declaration: stableSpan(item.span),
        parameters: item.parameters.map((parameter) =>
          stableSpan(parameter.span),
        ),
      });
    }
    if (item.kind === "trait") {
      item.methods.forEach((method) => {
        sources.set(method.symbol, {
          declaration: stableSpan(method.span),
          parameters: method.parameters.map((parameter) =>
            stableSpan(parameter.span),
          ),
        });
      });
    }
    if (item.kind === "effect") {
      item.operations.forEach((operation) => {
        sources.set(operation.symbol, {
          declaration: stableSpan(operation.span),
          parameters: operation.parameters.map((parameter) =>
            stableSpan(parameter.span),
          ),
        });
      });
    }
  }
  return sources;
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
}: {
  hir: HirGraph;
  symbolTable: SymbolTable;
  moduleId: string;
  modulePath: ModulePath;
  packageId: string;
  binding: BindingResult;
  typing: TypingResult;
  borrowing: BorrowingResult;
}): ModuleExportTable => {
  const table: ModuleExportTable = new Map();
  const borrowSummarySources = callableBorrowSummarySources(hir, moduleId);
  const firstPrivateFieldProjection = (
    type: number,
    path: readonly PlaceProjection[],
    active = new Set<string>(),
  ): number | undefined => {
    const key = `${type}:${JSON.stringify(path)}`;
    if (path.length === 0 || active.has(key)) {
      return undefined;
    }
    const nextActive = new Set(active).add(key);
    const descriptor = typing.arena.get(type);
    if (descriptor.kind === "borrowed") {
      return firstPrivateFieldProjection(
        descriptor.inner,
        path,
        nextActive,
      );
    }
    if (descriptor.kind === "recursive") {
      return firstPrivateFieldProjection(
        descriptor.body,
        path,
        nextActive,
      );
    }
    if (descriptor.kind === "union") {
      const candidates = descriptor.members.flatMap((member) => {
        const candidate = firstPrivateFieldProjection(
          member,
          path,
          nextActive,
        );
        return candidate === undefined ? [] : [candidate];
      });
      return candidates.length > 0 ? Math.min(...candidates) : undefined;
    }
    if (descriptor.kind === "intersection") {
      const candidates = [
        descriptor.nominal,
        descriptor.structural,
      ].flatMap((member) => {
        if (typeof member !== "number") {
          return [];
        }
        const candidate = firstPrivateFieldProjection(
          member,
          path,
          nextActive,
        );
        return candidate === undefined ? [] : [candidate];
      });
      return candidates.length > 0 ? Math.min(...candidates) : undefined;
    }
    const [projection, ...remaining] = path;
    if (
      projection?.kind === "dereference" ||
      projection?.kind === "identity" ||
      projection?.kind === "discriminant"
    ) {
      const nested = firstPrivateFieldProjection(
        type,
        remaining,
        active,
      );
      return nested === undefined ? undefined : nested + 1;
    }
    if (projection?.kind === "index" && descriptor.kind === "fixed-array") {
      const nested = firstPrivateFieldProjection(
        descriptor.element,
        remaining,
        nextActive,
      );
      return nested === undefined ? undefined : nested + 1;
    }
    const fields =
      descriptor.kind === "structural-object"
        ? descriptor.fields
        : descriptor.kind === "nominal-object" ||
            descriptor.kind === "value-object"
          ? typing.objectsByNominal.get(type)?.fields
          : undefined;
    const field =
      projection?.kind === "field"
        ? fields?.find((candidate) => candidate.name === projection.name)
        : projection?.kind === "tuple"
          ? fields?.[projection.index]
          : undefined;
    if (!field) {
      return undefined;
    }
    if (field.visibility !== undefined && field.visibility.api !== true) {
      return 0;
    }
    const nested = firstPrivateFieldProjection(
      field.type,
      remaining,
      nextActive,
    );
    return nested === undefined ? undefined : nested + 1;
  };
  const borrowSummaryPrivacyFor = (
    callableSymbol: SymbolId,
  ): CallableBorrowSummaryPrivacy | undefined => {
    const signature = typing.functions.getSignature(callableSymbol);
    if (!signature) {
      return undefined;
    }
    return {
      firstPrivateParameterProjection: (parameter, path) => {
        const type = signature.parameters[parameter]?.type;
        return typeof type === "number"
          ? firstPrivateFieldProjection(type, path)
          : undefined;
      },
      firstPrivateResultProjection: (path) =>
        firstPrivateFieldProjection(signature.returnType, path),
    };
  };

  const mergeEffects = (
    existing: readonly ModuleExportEffect[] | undefined,
    next?: ModuleExportEffect,
  ): readonly ModuleExportEffect[] | undefined => {
    if (!next) {
      return existing;
    }
    const bySymbol = new Map<SymbolId, ModuleExportEffect>();
    existing?.forEach((entry) => bySymbol.set(entry.symbol, entry));
    bySymbol.set(next.symbol, next);
    return Array.from(bySymbol.values());
  };

  const exportEffectFor = (
    symbol: SymbolId,
  ): ModuleExportEffect | undefined => {
    const signature = typing.functions.getSignature(symbol);
    if (!signature) {
      return undefined;
    }
    const desc = typing.effects.getRow(
      signature.effectRow ?? typing.primitives.defaultEffectRow,
    );
    return {
      symbol,
      annotated: signature.annotatedEffects,
      operations: desc.operations.map((op) => ({
        name: op.name,
        ...(typeof op.region === "number" ? { region: op.region } : {}),
      })),
      ...(desc.tailVar ? { tail: { rigid: desc.tailVar.rigid } } : {}),
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
    const symbols = existing
      ? new Set(existing.symbols ?? [existing.symbol])
      : new Set<SymbolId>();
    symbols.add(symbol);
    const overloadSet =
      binding.overloadBySymbol.get(symbol) ?? existing?.overloadSet;
    const record = symbolTable.getSymbol(symbol);
    const mergedVisibility = existing
      ? maxVisibility(existing.visibility, visibility)
      : visibility;
    const owner = existing?.memberOwner ?? memberOwner;
    const mergedStatic =
      existing?.isStatic === true ? true : (isStatic ?? existing?.isStatic);
    const projected = existing?.apiProjection || apiProjection === true;
    const effects = mergeEffects(existing?.effects, exportEffectFor(symbol));
    const borrowingContracts = new Map(
      existing?.borrowing?.map((entry) => [entry.symbol, entry]),
    );
    const addBorrowingSummary = (callableSymbol: SymbolId): void => {
      const borrowContract = borrowing.callables.get(callableSymbol);
      if (!borrowContract) {
        return;
      }
      const serialized = serializeCallableBorrowSummary({
        contract: borrowContract,
        namedContract: borrowing.namedContracts.get(callableSymbol),
        ...(typing.traitMethodImpls.has(callableSymbol)
          ? { dispatchHint: "trait-implementation" as const }
          : Array.from(hir.items.values()).some(
                (item) =>
                  item.kind === "trait" &&
                  item.methods.some(
                    (method) => method.symbol === callableSymbol,
                  ),
              )
            ? { dispatchHint: "trait-declaration" as const }
            : {}),
        ...(!typing.traitMethodImpls.has(callableSymbol) &&
        !borrowing.namedContracts.has(callableSymbol)
          ? {
              publicPrivacy: borrowSummaryPrivacyFor(callableSymbol),
            }
          : {}),
        source: borrowSummarySources.get(callableSymbol),
      });
      const publicContract =
        deserializeCallableBorrowSummary(serialized).contract;
      borrowingContracts.set(callableSymbol, {
        symbol: callableSymbol,
        serialized,
        serializedBytes: callableBorrowSummarySize(serialized),
        contract: publicContract,
      });
    };
    addBorrowingSummary(symbol);
    const owningDeclaration = Array.from(hir.items.values()).find(
      (item) =>
        (item.kind === "trait" || item.kind === "effect") &&
        item.symbol === symbol,
    );
    if (owningDeclaration?.kind === "trait") {
      owningDeclaration.methods.forEach((method) =>
        addBorrowingSummary(method.symbol),
      );
    }
    if (owningDeclaration?.kind === "effect") {
      owningDeclaration.operations.forEach((operation) =>
        addBorrowingSummary(operation.symbol),
      );
    }
    table.set(name, {
      name,
      symbol: existing?.symbol ?? symbol,
      symbols: Array.from(symbols),
      overloadSet,
      moduleId,
      modulePath,
      packageId,
      kind: record.kind,
      visibility: mergedVisibility,
      memberOwner: owner,
      isStatic: mergedStatic,
      apiProjection: projected,
      effects,
      borrowing: Array.from(borrowingContracts.values()),
    });
  };

  const memberInfoFor = (
    symbol: SymbolId,
  ): { owner?: SymbolId; isStatic?: boolean } => {
    const memberMetadata = typing.memberMetadata.get(symbol);
    const owner =
      typeof memberMetadata?.owner === "number"
        ? memberMetadata.owner
        : undefined;
    const recordMetadata = symbolTable.getSymbol(symbol).metadata as
      | { static?: boolean }
      | undefined;
    const isStatic = recordMetadata?.static === true;
    return { owner, isStatic };
  };

  hir.module.exports.forEach((entry) => {
    const record = symbolTable.getSymbol(entry.symbol);
    const name = entry.alias ?? record.name;
    const { owner: memberOwner, isStatic } = memberInfoFor(entry.symbol);
    upsertExport({
      name,
      symbol: entry.symbol,
      visibility: entry.visibility,
      memberOwner,
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
      const publicVisibility =
        metadata.visibility.level === "public"
          ? metadata.visibility
          : { ...metadata.visibility, level: "public" as const };
      upsertExport({
        name: record.name,
        symbol,
        visibility: publicVisibility,
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
