import type { Form } from "../parser/index.js";
import { isForm } from "../parser/index.js";
import type { ModuleGraph, ModuleNode, ModulePath } from "../modules/types.js";
import { SymbolTable } from "./binder/index.js";
import { runBindingPipeline } from "./binding/binding.js";
import type { BindingResult, BoundOverloadSet } from "./binding/binding.js";
import {
  walkExpression,
  type HirExpression,
  type HirGraph,
  type HirPattern,
} from "./hir/index.js";
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
import type { OverloadSetId, SourceSpan, SymbolId, TypeId } from "./ids.js";
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
  incrementCompilerPerfCounter,
  isCompilerPerfEnabled,
  markCompilerPerfPhaseDuration,
  startCompilerPerfPhase,
} from "../perf.js";
import { formatEffectRow } from "./effects/format.js";
import {
  analyzeBorrowing,
  callableBorrowSummarySize,
  deserializeCallableBorrowSummary,
  emptyBorrowingResult,
  redactPrivateSummaryPath,
  serializeCallableBorrowSummary,
  translateProjectionPath,
  type BorrowingResult,
  type CallableBorrowContract,
  type CallableResultInvocation,
  type CallableBorrowSummaryPrivacy,
  type CallableBorrowSummarySource,
  type PrivateSummaryPathRedaction,
  type PlaceProjection,
} from "./borrowing/index.js";
import { projectBorrowingDependencies } from "./borrowing/dependency-projection.js";
export {
  createBorrowingDependencyProjectionCache,
  projectBorrowingDependencies,
  snapshotBorrowingDependencyProjectionCacheStats,
  type BorrowingDependencyProjectionCache,
  type BorrowingDependencyProjectionCacheStats,
} from "./borrowing/dependency-projection.js";
import { localTraitRegionProjectionMetadata } from "./borrowing/trait-region-projection.js";
import { projectedTypes } from "./borrowing/call-resolution.js";
import {
  analyzeResultValueFlow,
  type ResultValueProjection,
  type ResultValueSource,
} from "./result-value-flow.js";
import {
  bindCallArgumentSources,
  omittedDefaultParameterIndices,
} from "./typing/call-argument-binding.js";

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
        checkBodies: checkBorrowBodies,
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
    dependencyExports: exports ?? new Map(),
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
  const borrowSummarySources = callableBorrowSummarySources(hir, moduleId);
  const opaquePrivateProjectionToken = (value: string): string => {
    let first = 5381;
    let second = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      first = (first * 33) ^ code;
      second = Math.imul(second ^ code, 16777619);
    }
    return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
  };
  const privateFieldProjection = (
    type: number,
    path: readonly PlaceProjection[],
    active = new Set<string>(),
  ): PrivateSummaryPathRedaction | undefined => {
    const key = `${type}:${JSON.stringify(path)}`;
    if (path.length === 0 || active.has(key)) {
      return undefined;
    }
    const nextActive = new Set(active).add(key);
    const descriptor = typing.arena.get(type);
    if (descriptor.kind === "borrowed") {
      return privateFieldProjection(descriptor.inner, path, nextActive);
    }
    if (descriptor.kind === "recursive") {
      return privateFieldProjection(descriptor.body, path, nextActive);
    }
    if (descriptor.kind === "union") {
      const candidates = descriptor.members.flatMap((member) => {
        const candidate = privateFieldProjection(member, path, nextActive);
        return candidate === undefined ? [] : [candidate];
      });
      return candidates.toSorted(
        (left, right) =>
          left.index - right.index || left.token.localeCompare(right.token),
      )[0];
    }
    if (descriptor.kind === "intersection") {
      const candidates = [descriptor.nominal, descriptor.structural].flatMap(
        (member) => {
          if (typeof member !== "number") {
            return [];
          }
          const candidate = privateFieldProjection(member, path, nextActive);
          return candidate === undefined ? [] : [candidate];
        },
      );
      return candidates.toSorted(
        (left, right) =>
          left.index - right.index || left.token.localeCompare(right.token),
      )[0];
    }
    const [projection, ...remaining] = path;
    if (
      projection?.kind === "dereference" ||
      projection?.kind === "identity" ||
      projection?.kind === "discriminant"
    ) {
      const nested = privateFieldProjection(type, remaining, active);
      return nested ? { ...nested, index: nested.index + 1 } : undefined;
    }
    if (projection?.kind === "index" && descriptor.kind === "fixed-array") {
      const nested = privateFieldProjection(
        descriptor.element,
        remaining,
        nextActive,
      );
      return nested ? { ...nested, index: nested.index + 1 } : undefined;
    }
    const fields =
      descriptor.kind === "structural-object"
        ? descriptor.fields
        : descriptor.kind === "nominal-object" ||
            descriptor.kind === "value-object"
          ? typing.objectsByNominal.get(type)?.fields
          : undefined;
    const fieldIndex =
      projection?.kind === "field"
        ? fields?.findIndex((candidate) => candidate.name === projection.name)
        : projection?.kind === "tuple"
          ? projection.index
          : -1;
    const field =
      typeof fieldIndex === "number" && fieldIndex >= 0
        ? fields?.[fieldIndex]
        : undefined;
    if (!field || typeof fieldIndex !== "number") {
      return undefined;
    }
    if (field.visibility !== undefined && field.visibility.api !== true) {
      const owner =
        descriptor.kind === "nominal-object" ||
        descriptor.kind === "value-object"
          ? `${descriptor.owner.moduleId}:${descriptor.owner.symbol}`
          : `${moduleId}:structural:${type}`;
      return {
        index: 0,
        token: opaquePrivateProjectionToken(`${owner}:${fieldIndex}`),
      };
    }
    const nested = privateFieldProjection(field.type, remaining, nextActive);
    return nested ? { ...nested, index: nested.index + 1 } : undefined;
  };
  const borrowSummaryPrivacyFor = (
    callableSymbol: SymbolId,
  ): CallableBorrowSummaryPrivacy | undefined => {
    const signature = typing.functions.getSignature(callableSymbol);
    if (!signature) {
      return undefined;
    }
    return {
      privateParameterProjection: (parameter, path) => {
        const type = signature.parameters[parameter]?.type;
        return typeof type === "number"
          ? privateFieldProjection(type, path)
          : undefined;
      },
      privateResultProjection: (path) =>
        privateFieldProjection(signature.returnType, path),
      privateCallbackResultProjection: (parameter, source, path) => {
        const parameterType = signature.parameters[parameter]?.type;
        if (typeof parameterType !== "number") {
          return undefined;
        }
        const callbackTypes =
          source.length === 0
            ? [parameterType]
            : projectedTypes(
                parameterType,
                valueProjectionPath(source),
                typing,
              );
        const privateProjections = callbackTypes
          .flatMap((type) => callableReturnTypesForType(type))
          .map((returnType) => privateFieldProjection(returnType, path))
          .filter(
            (projection): projection is PrivateSummaryPathRedaction =>
              projection !== undefined,
          );
        return privateProjections.length > 0
          ? privateProjections.toSorted(
              (left, right) =>
                left.index - right.index ||
                left.token.localeCompare(right.token),
            )[0]
          : undefined;
      },
    };
  };
  const imports = new Map(
    binding.imports.flatMap((entry) =>
      entry.target ? [[entry.local, entry.target] as const] : [],
    ),
  );
  const coercionProjectionGroups = new Map<
    string,
    ReturnType<typeof localTraitRegionProjectionMetadata>
  >();
  localTraitRegionProjectionMetadata({
    hir,
    typing,
    symbolTable,
    moduleId,
    imports,
  }).forEach((projection) => {
    const key = JSON.stringify([
      projection.concrete,
      projection.trait,
      projection.implementation,
    ]);
    coercionProjectionGroups.set(key, [
      ...(coercionProjectionGroups.get(key) ?? []),
      projection,
    ]);
  });
  const canonicalRef = (symbol: SymbolId) => {
    const metadata = (symbolTable.getSymbol(symbol).metadata ?? {}) as {
      import?: { moduleId?: unknown; symbol?: unknown };
    };
    return typeof metadata.import?.moduleId === "string" &&
      typeof metadata.import.symbol === "number"
      ? {
          moduleId: metadata.import.moduleId,
          symbol: metadata.import.symbol,
        }
      : { moduleId, symbol };
  };
  const localPublicTraitOwners = new Set([
    ...Array.from(hir.items.values()).flatMap((item) => {
      if (
        item.kind !== "trait" ||
        (item.visibility.level !== "package" &&
          item.visibility.level !== "public")
      ) {
        return [];
      }
      const owner = canonicalRef(item.symbol);
      return [`${owner.moduleId}:${owner.symbol}`];
    }),
    ...hir.module.exports.flatMap((entry) => {
      if (
        (entry.visibility.level !== "package" &&
          entry.visibility.level !== "public") ||
        symbolTable.getSymbol(entry.symbol).kind !== "trait"
      ) {
        return [];
      }
      const owner = canonicalRef(entry.symbol);
      return [`${owner.moduleId}:${owner.symbol}`];
    }),
  ]);
  const traitIsPublic = (trait: {
    moduleId: string;
    symbol: SymbolId;
  }): boolean => {
    if (localPublicTraitOwners.has(`${trait.moduleId}:${trait.symbol}`)) {
      return true;
    }
    return Array.from(
      dependencyExports.get(trait.moduleId)?.values() ?? [],
    ).some(
      (entry) =>
        entry.kind === "trait" &&
        (entry.symbol === trait.symbol ||
          entry.symbols?.includes(trait.symbol) === true),
    );
  };
  const sourceTypeFor = (symbol: SymbolId): TypeId | undefined =>
    Array.from(typing.objectsByNominal.keys()).find((type) => {
      const descriptor = typing.arena.get(type);
      return (
        descriptor.kind === "nominal-object" &&
        descriptor.owner.moduleId === moduleId &&
        descriptor.owner.symbol === symbol
      );
    });
  type ExportedCoercion = NonNullable<
    ModuleExportEntry["borrowingCoercions"]
  >[number];
  const coercionForProjectionGroup = (
    projections: ReturnType<typeof localTraitRegionProjectionMetadata>,
  ): ExportedCoercion | undefined => {
    if (
      borrowing.diagnostics.some(
        (diagnostic) => diagnostic.severity === "error",
      )
    ) {
      return undefined;
    }
    const first = projections[0];
    if (!first || first.concrete.moduleId !== moduleId) {
      return undefined;
    }
    const sourceType = sourceTypeFor(first.concrete.symbol);
    if (typeof sourceType !== "number") {
      return undefined;
    }
    const implementationNamed = first.implementationMethods
      .map((method) => borrowing.namedContracts.get(method))
      .find((contract) => contract !== undefined);
    if (!implementationNamed) {
      return undefined;
    }
    const { implementation: _implementation, ...namedContract } =
      implementationNamed;
    const contract = {
      parameters: [
        {
          access: "shared" as const,
          retained: false,
          returned: true,
          returnedAggregate: true as const,
          returnedOrigins: projections.map((projection) => ({
            source: projection.source,
            result: [projection.result],
            endpointAccess: "inline" as const,
          })),
        },
      ],
      maySuspend: false,
    };
    const serialized = serializeCallableBorrowSummary({
      contract,
      namedContract,
      publicPrivacy: {
        privateParameterProjection: (_parameter, path) =>
          privateFieldProjection(sourceType, path),
        privateResultProjection: () => undefined,
        privateCallbackResultProjection: () => undefined,
      },
    });
    return {
      concrete: first.concrete,
      trait: first.trait,
      implementation: first.implementation,
      serialized,
      serializedBytes: callableBorrowSummarySize(serialized),
      contract: deserializeCallableBorrowSummary(serialized).contract,
    };
  };
  const localCoercions = new Map<string, ExportedCoercion>();
  coercionProjectionGroups.forEach((projections, key) => {
    const coercion = coercionForProjectionGroup(projections);
    if (coercion) {
      localCoercions.set(key, coercion);
    }
  });
  const coercionKey = (
    coercion: Pick<
      ExportedCoercion,
      "concrete" | "trait" | "implementation" | "resultPaths" | "resultType"
    >,
  ): string =>
    JSON.stringify([
      coercion.concrete,
      coercion.trait,
      coercion.implementation,
      coercion.resultPaths,
      coercion.resultType,
    ]);
  const projectionPathStartsWith = (
    path: readonly PlaceProjection[],
    prefix: readonly PlaceProjection[],
  ): boolean =>
    prefix.length <= path.length &&
    prefix.every(
      (projection, index) =>
        JSON.stringify(projection) === JSON.stringify(path[index]),
    );
  const translatedCoercionReachability = ({
    coercion,
    requested,
    result,
    requestedTypes = [],
    resultType,
  }: {
    coercion: ExportedCoercion;
    requested: readonly PlaceProjection[];
    result: readonly PlaceProjection[];
    requestedTypes?: readonly { moduleId: string; symbol: SymbolId }[];
    resultType?: { moduleId: string; symbol: SymbolId };
  }): ExportedCoercion | undefined => {
    if (
      coercion.resultType &&
      requestedTypes.length > 0 &&
      !requestedTypes.some(
        (type) =>
          type.moduleId === coercion.resultType?.moduleId &&
          type.symbol === coercion.resultType.symbol,
      )
    ) {
      return undefined;
    }
    const translatedResultType =
      resultType ??
      (requestedTypes.length === 0 ? coercion.resultType : undefined);
    if (!coercion.resultPaths) {
      return {
        ...coercion,
        resultPaths: [result],
        resultType: translatedResultType,
      };
    }
    const resultPaths = coercion.resultPaths.flatMap((path) =>
      projectionPathStartsWith(path, requested)
        ? [[...result, ...path.slice(requested.length)]]
        : [],
    );
    return resultPaths.length > 0
      ? {
          ...coercion,
          resultPaths,
          resultType: translatedResultType,
        }
      : undefined;
  };
  const mergeCoercionReachability = (
    coercions: readonly ExportedCoercion[],
  ): readonly ExportedCoercion[] => {
    const merged = new Map<string, ExportedCoercion>();
    coercions.forEach((coercion) => {
      const key = coercionKey(coercion);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, coercion);
        return;
      }
      if (!existing.applicability || !coercion.applicability) {
        const { applicability: _applicability, ...unconditional } =
          existing.applicability ? coercion : existing;
        merged.set(key, unconditional);
        return;
      }
      const applicability = new Map(
        existing.applicability.map((entry) => [
          `${entry.callable.moduleId}:${entry.callable.symbol}`,
          entry,
        ]),
      );
      coercion.applicability.forEach((candidate) => {
        const applicabilityKey = `${candidate.callable.moduleId}:${candidate.callable.symbol}`;
        const current = applicability.get(applicabilityKey);
        if (!current) {
          applicability.set(applicabilityKey, candidate);
          return;
        }
        if (!current.omissionRequirements || !candidate.omissionRequirements) {
          applicability.set(applicabilityKey, {
            callable: candidate.callable,
          });
          return;
        }
        applicability.set(applicabilityKey, {
          callable: candidate.callable,
          omissionRequirements: Array.from(
            new Map(
              [
                ...current.omissionRequirements,
                ...candidate.omissionRequirements,
              ].map((requirement) => [
                JSON.stringify(requirement),
                requirement,
              ]),
            ).values(),
          ),
        });
      });
      merged.set(key, {
        ...existing,
        applicability: Array.from(applicability.values()),
      });
    });
    return Array.from(merged.values());
  };
  const nominalTypeOf = (type: TypeId | undefined): TypeId | undefined => {
    if (typeof type !== "number") {
      return undefined;
    }
    const descriptor = typing.arena.get(type);
    return descriptor.kind === "nominal-object"
      ? type
      : descriptor.kind === "intersection"
        ? descriptor.nominal
        : undefined;
  };
  const traitTypesIn = (
    type: TypeId | undefined,
    active = new Set<TypeId>(),
  ): readonly TypeId[] => {
    if (typeof type !== "number" || active.has(type)) {
      return [];
    }
    active.add(type);
    const descriptor = typing.arena.get(type);
    if (descriptor.kind === "trait") {
      return [type];
    }
    if (descriptor.kind === "intersection") {
      return descriptor.traits ?? [];
    }
    if (descriptor.kind === "union") {
      return descriptor.members.flatMap((member) =>
        traitTypesIn(member, new Set(active)),
      );
    }
    if (descriptor.kind === "recursive") {
      return traitTypesIn(descriptor.body, active);
    }
    return [];
  };
  const directCoercionsForTypes = (
    sourceType: TypeId | undefined,
    targetType: TypeId | undefined,
  ): readonly ExportedCoercion[] => {
    const nominal = nominalTypeOf(sourceType);
    if (typeof nominal !== "number") {
      return [];
    }
    const targetTraits = new Set(traitTypesIn(targetType));
    if (targetTraits.size === 0) {
      return [];
    }
    const selectedImplementations = new Set(
      (
        typing.traitImplsByNominal.get(nominal) ??
        (typeof sourceType === "number"
          ? typing.traitImplsByNominal.get(sourceType)
          : undefined) ??
        typing.traitImplsByNominal.get(
          typing.objectsByNominal.get(nominal)?.type ??
            typing.primitives.unknown,
        ) ??
        []
      )
        .filter((implementation) => targetTraits.has(implementation.trait))
        .map((implementation) =>
          JSON.stringify(canonicalRef(implementation.implSymbol)),
        ),
    );
    const nominalDescriptor = typing.arena.get(nominal);
    const targetTraitOwners = new Set(
      Array.from(targetTraits).flatMap((trait) => {
        const descriptor = typing.arena.get(trait);
        return descriptor.kind === "trait"
          ? [`${descriptor.owner.moduleId}:${descriptor.owner.symbol}`]
          : [];
      }),
    );
    const candidates = Array.from(localCoercions.values()).filter(
      (coercion) =>
        traitIsPublic(coercion.trait) &&
        nominalDescriptor.kind === "nominal-object" &&
        coercion.concrete.moduleId === nominalDescriptor.owner.moduleId &&
        coercion.concrete.symbol === nominalDescriptor.owner.symbol &&
        targetTraitOwners.has(
          `${coercion.trait.moduleId}:${coercion.trait.symbol}`,
        ),
    );
    return selectedImplementations.size === 0
      ? candidates
      : candidates.filter((coercion) =>
          selectedImplementations.has(JSON.stringify(coercion.implementation)),
        );
  };
  const expressionTypeFor = (exprId: number): TypeId | undefined => {
    const direct =
      typing.resolvedExprTypes.get(exprId) ?? typing.table.getExprType(exprId);
    if (typeof direct === "number") {
      return direct;
    }
    const expression = hir.expressions.get(exprId);
    if (
      expression?.exprKind === "object-literal" &&
      typeof expression.target?.typeId === "number"
    ) {
      return expression.target.typeId;
    }
    if (
      expression?.exprKind === "object-literal" &&
      typeof expression.targetSymbol === "number"
    ) {
      return sourceTypeFor(expression.targetSymbol);
    }
    return expression?.exprKind === "identifier"
      ? typing.valueTypes.get(expression.symbol)
      : undefined;
  };
  const nominalOwnersForType = (
    type: TypeId,
    active = new Set<TypeId>(),
  ): ReadonlySet<string> => {
    if (active.has(type)) {
      return new Set();
    }
    const nextActive = new Set(active).add(type);
    const descriptor = typing.arena.get(type);
    if (
      descriptor.kind === "nominal-object" ||
      descriptor.kind === "value-object"
    ) {
      return new Set([
        `${descriptor.owner.moduleId}:${descriptor.owner.symbol}`,
      ]);
    }
    if (descriptor.kind === "borrowed") {
      return nominalOwnersForType(descriptor.inner, nextActive);
    }
    if (descriptor.kind === "recursive") {
      return nominalOwnersForType(descriptor.body, nextActive);
    }
    if (descriptor.kind === "union") {
      return new Set(
        descriptor.members.flatMap((member) =>
          Array.from(nominalOwnersForType(member, nextActive)),
        ),
      );
    }
    if (descriptor.kind === "intersection") {
      return new Set(
        [descriptor.nominal, descriptor.structural]
          .filter((member): member is TypeId => typeof member === "number")
          .flatMap((member) =>
            Array.from(nominalOwnersForType(member, nextActive)),
          ),
      );
    }
    if (descriptor.kind === "type-param-ref") {
      const constraint = typing.typeParameterConstraints.get(descriptor.param);
      return typeof constraint === "number"
        ? nominalOwnersForType(constraint, nextActive)
        : new Set();
    }
    return new Set();
  };
  const nominalOwnerRefsForType = (
    type: TypeId | undefined,
    active = new Set<TypeId>(),
  ): readonly { moduleId: string; symbol: SymbolId }[] => {
    if (typeof type !== "number" || active.has(type)) {
      return [];
    }
    const nextActive = new Set(active).add(type);
    const descriptor = typing.arena.get(type);
    if (
      descriptor.kind === "nominal-object" ||
      descriptor.kind === "value-object"
    ) {
      return [descriptor.owner];
    }
    if (descriptor.kind === "borrowed") {
      return nominalOwnerRefsForType(descriptor.inner, nextActive);
    }
    if (descriptor.kind === "recursive") {
      return nominalOwnerRefsForType(descriptor.body, nextActive);
    }
    if (descriptor.kind === "union") {
      return descriptor.members.flatMap((member) =>
        nominalOwnerRefsForType(member, nextActive),
      );
    }
    if (descriptor.kind === "intersection") {
      return [descriptor.nominal, descriptor.structural]
        .filter((member): member is TypeId => typeof member === "number")
        .flatMap((member) => nominalOwnerRefsForType(member, nextActive));
    }
    return [];
  };
  const typeIsVariantUnion = (
    type: TypeId | undefined,
    active = new Set<TypeId>(),
  ): boolean => {
    if (typeof type !== "number" || active.has(type)) {
      return false;
    }
    const nextActive = new Set(active).add(type);
    const descriptor = typing.arena.get(type);
    if (descriptor.kind === "union") {
      return true;
    }
    return descriptor.kind === "recursive"
      ? typeIsVariantUnion(descriptor.body, nextActive)
      : false;
  };
  const callableReturnTypesForType = (
    type: TypeId,
    active = new Set<TypeId>(),
  ): readonly TypeId[] => {
    if (active.has(type)) {
      return [];
    }
    const nextActive = new Set(active).add(type);
    const descriptor = typing.arena.get(type);
    if (descriptor.kind === "function") {
      return [descriptor.returnType];
    }
    if (descriptor.kind === "recursive") {
      return callableReturnTypesForType(descriptor.body, nextActive);
    }
    if (descriptor.kind === "union") {
      return descriptor.members.flatMap((member) =>
        callableReturnTypesForType(member, nextActive),
      );
    }
    return [];
  };
  const resultValueFlow = analyzeResultValueFlow({
    hir,
    spreadProvidesField: (value, field) => {
      const spreadType = expressionTypeFor(value);
      return (
        typeof spreadType === "number" &&
        projectedTypes(spreadType, [{ kind: "field", name: field }], typing)
          .length > 0
      );
    },
    expressionMayHaveType: (value, type) => {
      const expectedOwners = nominalOwnersForType(type);
      if (expectedOwners.size === 0) {
        return true;
      }
      const valueType = expressionTypeFor(value);
      if (typeof valueType !== "number") {
        return true;
      }
      const valueOwners = nominalOwnersForType(valueType);
      return (
        valueOwners.size === 0 ||
        Array.from(valueOwners).some((owner) => expectedOwners.has(owner))
      );
    },
  });
  const resultProjectionsForType = (
    type: TypeId | undefined,
    active = new Set<TypeId>(),
  ): readonly ResultValueProjection[] => {
    if (typeof type !== "number" || active.has(type)) {
      return [];
    }
    const nextActive = new Set(active).add(type);
    const descriptor = typing.arena.get(type);
    if (descriptor.kind === "recursive") {
      return resultProjectionsForType(descriptor.body, nextActive);
    }
    if (descriptor.kind === "union") {
      return Array.from(
        new Map(
          descriptor.members
            .flatMap((member) => resultProjectionsForType(member, nextActive))
            .map((projection) => [JSON.stringify(projection), projection]),
        ).values(),
      );
    }
    if (descriptor.kind === "intersection") {
      return Array.from(
        new Map(
          [descriptor.nominal, descriptor.structural]
            .flatMap((member) => resultProjectionsForType(member, nextActive))
            .map((projection) => [JSON.stringify(projection), projection]),
        ).values(),
      );
    }
    const fields =
      descriptor.kind === "structural-object"
        ? descriptor.fields
        : descriptor.kind === "nominal-object" ||
            descriptor.kind === "value-object"
          ? typing.objectsByNominal.get(type)?.fields
          : undefined;
    return (
      fields?.map((field) => {
        const index = Number(field.name);
        return Number.isInteger(index)
          ? ({ kind: "tuple", index } as const)
          : ({ kind: "field", name: field.name } as const);
      }) ?? []
    );
  };
  const publicTraitExposureByType = new Map<TypeId, boolean>();
  const typeCanExposePublicTrait = (type: TypeId | undefined): boolean => {
    if (typeof type !== "number") {
      return false;
    }
    const cached = publicTraitExposureByType.get(type);
    if (cached !== undefined) {
      return cached;
    }

    const pending = [type];
    const visited = new Set<TypeId>();
    const predecessors = new Map<TypeId, Set<TypeId>>();
    let positive: TypeId | undefined;
    const enqueue = (parent: TypeId, child: TypeId): void => {
      const parents = predecessors.get(child) ?? new Set<TypeId>();
      parents.add(parent);
      predecessors.set(child, parents);
      pending.push(child);
    };
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (visited.has(current)) {
        continue;
      }
      const known = publicTraitExposureByType.get(current);
      if (known === true) {
        positive = current;
        break;
      }
      if (known === false) {
        continue;
      }
      visited.add(current);
      const descriptor = typing.arena.get(current);
      if (descriptor.kind === "trait" && traitIsPublic(descriptor.owner)) {
        positive = current;
        break;
      }
      if (descriptor.kind === "borrowed") {
        enqueue(current, descriptor.inner);
      } else if (descriptor.kind === "recursive") {
        enqueue(current, descriptor.body);
      } else if (descriptor.kind === "union") {
        descriptor.members.forEach((member) => enqueue(current, member));
      } else if (descriptor.kind === "intersection") {
        [
          descriptor.nominal,
          descriptor.structural,
          ...(descriptor.traits ?? []),
        ].forEach((member) => {
          if (typeof member === "number") {
            enqueue(current, member);
          }
        });
      } else if (descriptor.kind === "fixed-array") {
        enqueue(current, descriptor.element);
      } else if (descriptor.kind === "type-param-ref") {
        const constraint = typing.typeParameterConstraints.get(
          descriptor.param,
        );
        if (typeof constraint === "number") {
          enqueue(current, constraint);
        }
      } else {
        const fields =
          descriptor.kind === "structural-object"
            ? descriptor.fields
            : descriptor.kind === "nominal-object" ||
                descriptor.kind === "value-object"
              ? typing.objectsByNominal.get(current)?.fields
              : undefined;
        fields?.forEach((field) => enqueue(current, field.type));
      }
    }
    if (positive !== undefined) {
      const positiveAncestors = [positive];
      const marked = new Set<TypeId>();
      while (positiveAncestors.length > 0) {
        const current = positiveAncestors.pop()!;
        if (marked.has(current)) {
          continue;
        }
        marked.add(current);
        publicTraitExposureByType.set(current, true);
        predecessors
          .get(current)
          ?.forEach((parent) => positiveAncestors.push(parent));
      }
      return true;
    }
    visited.forEach((current) => publicTraitExposureByType.set(current, false));
    return false;
  };
  const valueProjectionPath = (
    path: readonly PlaceProjection[],
  ): readonly ResultValueProjection[] =>
    path.flatMap((projection): readonly ResultValueProjection[] => {
      if (projection.kind === "field") {
        return [{ kind: "field" as const, name: projection.name }];
      }
      if (projection.kind === "tuple") {
        return [{ kind: "tuple" as const, index: projection.index }];
      }
      return [];
    });
  type ParameterResultOrigin = {
    parameter: number;
    source: readonly PlaceProjection[];
    result: readonly PlaceProjection[];
  };
  const parameterResultOriginsForContract = (
    contract: CallableBorrowContract,
  ): readonly ParameterResultOrigin[] =>
    contract.parameters.flatMap((parameter, index) => {
      if (!parameter.returned) {
        return [];
      }
      const origins =
        parameter.returnedOrigins && parameter.returnedOrigins.length > 0
          ? parameter.returnedOrigins
          : (parameter.returnedPaths && parameter.returnedPaths.length > 0
              ? parameter.returnedPaths
              : [[]]
            ).map((source) => ({ source, result: [] }));
      return origins.map((origin) => ({
        parameter: index,
        source: origin.source,
        result: origin.result,
      }));
    });
  const dependencyContractFor = (target: {
    moduleId: string;
    symbol: SymbolId;
  }): CallableBorrowContract | undefined => {
    const summary = Array.from(
      dependencyExports.get(target.moduleId)?.values() ?? [],
    )
      .flatMap((entry) => entry.borrowing ?? [])
      .find((entry) => entry.symbol === target.symbol);
    if (!summary) {
      return undefined;
    }
    return summary.serialized
      ? deserializeCallableBorrowSummary(summary.serialized).contract
      : summary.contract;
  };
  const localCallParameters = new Map(
    Array.from(hir.items.values()).flatMap((item) =>
      item.kind === "function" ? [[item.symbol, item.parameters] as const] : [],
    ),
  );
  const localFunctions = new Map(
    Array.from(hir.items.values()).flatMap((item) =>
      item.kind === "function" ? [[item.symbol, item] as const] : [],
    ),
  );
  const resultProjectionForField = (field: string): ResultValueProjection => {
    const index = Number(field);
    return Number.isInteger(index)
      ? { kind: "tuple", index }
      : { kind: "field", name: field };
  };
  const resultValueSources = (
    sources: ReturnType<typeof bindCallArgumentSources>,
  ): readonly (ResultValueSource | undefined)[] =>
    sources.map((source) => {
      if (!source || source.moduleId !== moduleId) {
        return undefined;
      }
      const index =
        typeof source.field === "string" ? Number(source.field) : NaN;
      const projections =
        typeof source.field !== "string"
          ? []
          : Number.isInteger(index)
            ? [{ kind: "tuple" as const, index }]
            : [{ kind: "field" as const, name: source.field }];
      return { expression: source.expression, projections };
    });
  const callTargetsFor = (
    exprId: number,
  ): readonly {
    moduleId: string;
    symbol: SymbolId;
  }[] => {
    const expression = hir.expressions.get(exprId);
    const callee =
      expression?.exprKind === "call"
        ? hir.expressions.get(expression.callee)
        : undefined;
    const direct =
      callee?.exprKind === "identifier" ? [canonicalRef(callee.symbol)] : [];
    return Array.from(
      new Map(
        [
          ...(typing.callTargets.get(exprId)?.values() ?? []),
          ...(typing.borrowCallTargets.get(exprId)?.values() ?? []),
          ...direct,
        ].map((target) => [`${target.moduleId}:${target.symbol}`, target]),
      ).values(),
    );
  };
  const callParametersForTarget = ({
    expression,
    target,
  }: {
    expression: HirExpression;
    target: { moduleId: string; symbol: SymbolId };
  }) => {
    if (target.moduleId === moduleId) {
      return localCallParameters.get(target.symbol);
    }
    const callee =
      expression.exprKind === "call"
        ? hir.expressions.get(expression.callee)
        : undefined;
    return callee?.exprKind === "identifier" &&
      canonicalRef(callee.symbol).moduleId === target.moduleId &&
      canonicalRef(callee.symbol).symbol === target.symbol
      ? typing.functions.getSignature(callee.symbol)?.parameters
      : undefined;
  };
  type CallableParameterInvocation = {
    parameter: number;
    source: readonly ResultValueProjection[];
  };
  const callableParameterBindings = new Map<
    SymbolId,
    Map<SymbolId, CallableParameterInvocation>
  >(
    Array.from(localFunctions.entries()).map(([symbol, item]) => {
      const bindings = new Map<SymbolId, CallableParameterInvocation>();
      const addPatternBindings = (
        pattern: HirPattern,
        parameter: number,
        source: readonly ResultValueProjection[] = [],
      ): void => {
        if (pattern.kind === "identifier") {
          bindings.set(pattern.symbol, { parameter, source });
          return;
        }
        if (pattern.kind === "destructure") {
          pattern.fields.forEach((field) =>
            addPatternBindings(field.pattern, parameter, [
              ...source,
              { kind: "field", name: field.name },
            ]),
          );
          if (pattern.spread) {
            addPatternBindings(pattern.spread, parameter, source);
          }
          return;
        }
        if (pattern.kind === "tuple") {
          pattern.elements.forEach((element, index) =>
            addPatternBindings(element, parameter, [
              ...source,
              { kind: "tuple", index },
            ]),
          );
          return;
        }
        if (pattern.kind === "type" && pattern.binding) {
          addPatternBindings(pattern.binding, parameter, source);
        }
      };
      item.parameters.forEach((parameter, index) =>
        addPatternBindings(parameter.pattern, index),
      );
      return [symbol, bindings];
    }),
  );
  const directParameterInvocationForExpression = ({
    expressionId,
    bindings,
  }: {
    expressionId: number;
    bindings: ReadonlyMap<SymbolId, CallableParameterInvocation>;
  }): CallableParameterInvocation | undefined => {
    const expression = hir.expressions.get(expressionId);
    if (expression?.exprKind === "identifier") {
      return bindings.get(expression.symbol);
    }
    if (expression?.exprKind !== "field-access") {
      return undefined;
    }
    const target = directParameterInvocationForExpression({
      expressionId: expression.target,
      bindings,
    });
    if (!target) {
      return undefined;
    }
    const index = Number(expression.field);
    return {
      parameter: target.parameter,
      source: [
        ...target.source,
        Number.isInteger(index)
          ? { kind: "tuple", index }
          : { kind: "field", name: expression.field },
      ],
    };
  };
  const exposedResultPathsForType = (
    type: TypeId | undefined,
    active = new Set<TypeId>(),
  ): readonly (readonly ResultValueProjection[])[] => {
    if (
      typeof type !== "number" ||
      active.has(type) ||
      !typeCanExposePublicTrait(type)
    ) {
      return [];
    }
    const nextActive = new Set(active).add(type);
    const projections = resultProjectionsForType(type);
    if (projections.length === 0) {
      return [[]];
    }
    return projections.flatMap((projection) =>
      projectedTypes(type, [projection], typing).flatMap((projected) =>
        exposedResultPathsForType(projected, nextActive).map((nested) => [
          projection,
          ...nested,
        ]),
      ),
    );
  };
  const returnedCallExpressions = (
    symbol: SymbolId,
  ): readonly {
    expression: number;
    callbackResult: readonly ResultValueProjection[];
    callbackResultType?: { moduleId: string; symbol: SymbolId };
    result: readonly ResultValueProjection[];
  }[] => {
    const item = localFunctions.get(symbol);
    if (!item) {
      return [];
    }
    const returnType = typing.functions.getSignature(symbol)?.returnType;
    return exposedResultPathsForType(returnType).flatMap((result) =>
      resultValueFlow.resultsForCallable(item.body).flatMap((returned) =>
        resultValueFlow
          .sourcesForExpression(returned, result)
          .flatMap((source) => {
            const expression = hir.expressions.get(source.expression);
            const callbackResultType = nominalOwnerRefsForType(
              source.typeFilter,
            )[0];
            return expression?.exprKind === "call" ||
              expression?.exprKind === "method-call"
              ? [
                  {
                    expression: source.expression,
                    callbackResult: source.projections,
                    ...(callbackResultType ? { callbackResultType } : {}),
                    result,
                  },
                ]
              : [];
          }),
      ),
    );
  };
  const callableResultInvocations = new Map<
    SymbolId,
    Map<string, CallableResultInvocation>
  >(
    Array.from(localFunctions.keys()).map((symbol) => [
      symbol,
      new Map<string, CallableResultInvocation>(),
    ]),
  );
  const addCallableResultInvocation = (
    symbol: SymbolId,
    invocation: CallableResultInvocation,
  ): boolean => {
    const invocations = callableResultInvocations.get(symbol);
    if (!invocations) {
      return false;
    }
    const key = JSON.stringify(invocation);
    if (invocations.has(key)) {
      return false;
    }
    invocations.set(key, invocation);
    return true;
  };
  const callableSourcesForCallResult = ({
    expressionId,
    requested,
    useAtExpression,
  }: {
    expressionId: number;
    requested: readonly PlaceProjection[];
    useAtExpression: number;
  }): readonly ResultValueSource[] => {
    const expression = hir.expressions.get(expressionId);
    if (
      expression?.exprKind !== "call" &&
      expression?.exprKind !== "method-call"
    ) {
      return [];
    }
    const candidates = [
      {
        targets: typing.callTargets.get(expressionId),
        plans: typing.callArgumentPlans.get(expressionId),
      },
      {
        targets: typing.borrowCallTargets.get(expressionId),
        plans: typing.borrowCallArgumentPlans.get(expressionId),
      },
      ...((typing.callTargets.get(expressionId)?.size ?? 0) === 0 &&
      (typing.borrowCallTargets.get(expressionId)?.size ?? 0) === 0
        ? [
            {
              targets: new Map(
                callTargetsFor(expressionId).map((target, index) => [
                  `direct:${index}`,
                  target,
                ]),
              ),
              plans: undefined,
            },
          ]
        : []),
    ].flatMap(({ targets, plans }) =>
      Array.from(targets?.entries() ?? []).flatMap(([instanceKey, target]) => {
        const contract =
          target.moduleId === moduleId
            ? borrowing.callables.get(target.symbol)
            : dependencyContractFor(target);
        if (!contract) {
          return [];
        }
        const parameters = callParametersForTarget({ expression, target });
        const directPlan = plans?.get(instanceKey);
        const candidatePlans = directPlan
          ? [directPlan]
          : plans && plans.size > 0
            ? Array.from(plans.values())
            : [undefined];
        return candidatePlans.flatMap((plan) => {
          const sources = bindCallArgumentSources({
            expression,
            plan,
            parameters:
              target.moduleId === moduleId
                ? localCallParameters.get(target.symbol)
                : parameters,
            callerModuleId: moduleId,
            parameterModuleId: target.moduleId,
            hir,
          });
          const omitted = new Set(
            omittedDefaultParameterIndices({
              expression,
              plan,
              parameters,
              callerModuleId: moduleId,
              hir,
            }),
          );
          const sourcesForParameter = (
            parameter: number,
            path: readonly PlaceProjection[],
            active = new Set<string>(),
          ): readonly ResultValueSource[] => {
            const key = `${parameter}:${JSON.stringify(path)}`;
            if (active.has(key)) {
              return [];
            }
            const nextActive = new Set(active).add(key);
            const source = sources[parameter];
            const direct =
              source?.moduleId === moduleId
                ? resultValueFlow.sourcesForExpression(
                    source.expression,
                    [
                      ...(typeof source.field === "string"
                        ? [resultProjectionForField(source.field)]
                        : []),
                      ...valueProjectionPath(path),
                    ],
                    useAtExpression,
                  )
                : [];
            if (!omitted.has(parameter)) {
              return direct;
            }
            const defaults =
              contract.parameters[parameter]?.defaultOrigins?.flatMap(
                (origin) => {
                  const translated = translateProjectionPath({
                    result: origin.result,
                    source: origin.source,
                    requested: path,
                  });
                  return translated
                    ? sourcesForParameter(
                        origin.parameter,
                        translated,
                        nextActive,
                      )
                    : [];
                },
              ) ?? [];
            return [...direct, ...defaults];
          };
          return parameterResultOriginsForContract(contract).flatMap(
            (origin) => {
              const translated = translateProjectionPath({
                result: origin.result,
                source: origin.source,
                requested,
              });
              return translated
                ? sourcesForParameter(origin.parameter, translated)
                : [];
            },
          );
        });
      }),
    );
    return Array.from(
      new Map(
        candidates.map((source) => [
          JSON.stringify([
            source.expression,
            source.projections,
            source.typeFilter,
          ]),
          source,
        ]),
      ).values(),
    );
  };
  const callableValueSourcesForExpression = ({
    expressionId,
    callablePath = [],
    useAtExpression,
    active = new Set<string>(),
  }: {
    expressionId: number;
    callablePath?: readonly ResultValueProjection[];
    useAtExpression: number;
    active?: ReadonlySet<string>;
  }): readonly ResultValueSource[] => {
    const activeKey = JSON.stringify([expressionId, callablePath]);
    if (active.has(activeKey)) {
      return [];
    }
    const nextActive = new Set(active).add(activeKey);
    return resultValueFlow
      .sourcesForExpression(expressionId, callablePath, useAtExpression)
      .flatMap((source) => {
        const expression = hir.expressions.get(source.expression);
        if (
          expression?.exprKind !== "call" &&
          expression?.exprKind !== "method-call"
        ) {
          return [source];
        }
        return callableSourcesForCallResult({
          expressionId: source.expression,
          requested: source.projections,
          useAtExpression,
        }).flatMap((returned) =>
          callableValueSourcesForExpression({
            expressionId: returned.expression,
            callablePath: returned.projections,
            useAtExpression,
            active: nextActive,
          }),
        );
      });
  };
  let defaultCallableResultCoercionsFor = (
    _symbol: SymbolId,
  ): readonly ExportedCoercion[] => [];
  const callableValueCoercionsForExpression = ({
    expressionId,
    callablePath = [],
    requested,
    result,
    useAtExpression,
    active = new Set<string>(),
  }: {
    expressionId: number;
    callablePath?: readonly ResultValueProjection[];
    requested: readonly PlaceProjection[];
    result: readonly PlaceProjection[];
    useAtExpression: number;
    active?: ReadonlySet<string>;
  }): readonly ExportedCoercion[] => {
    const activeKey = JSON.stringify([
      expressionId,
      callablePath,
      requested,
      result,
    ]);
    if (active.has(activeKey)) {
      return [];
    }
    const nextActive = new Set(active).add(activeKey);
    return resultValueFlow
      .sourcesForExpression(expressionId, callablePath, useAtExpression)
      .flatMap((source) => {
        const expression = hir.expressions.get(source.expression);
        if (
          expression?.exprKind !== "call" &&
          expression?.exprKind !== "method-call"
        ) {
          return [];
        }
        const direct = callTargetsFor(source.expression).flatMap((target) => {
          const entries =
            target.moduleId === moduleId
              ? [
                  {
                    symbol: target.symbol,
                    borrowingCallableResultCoercions:
                      defaultCallableResultCoercionsFor(target.symbol),
                  },
                ]
              : Array.from(
                  dependencyExports.get(target.moduleId)?.values() ?? [],
                );
          return entries
            .filter(
              (entry) =>
                entry.symbol === target.symbol ||
                ("symbols" in entry &&
                  entry.symbols?.includes(target.symbol) === true),
            )
            .flatMap((entry) => entry.borrowingCallableResultCoercions ?? [])
            .filter((coercion) => traitIsPublic(coercion.trait))
            .filter((coercion) =>
              coercionAppliesToCall({
                coercion,
                exprId: source.expression,
                target,
              }),
            )
            .flatMap((coercion) => {
              const { applicability: _applicability, ...resolved } = coercion;
              const translated = translatedCoercionReachability({
                coercion: resolved,
                requested,
                result,
              });
              return translated ? [translated] : [];
            });
        });
        const nested = callableSourcesForCallResult({
          expressionId: source.expression,
          requested: source.projections,
          useAtExpression,
        }).flatMap((returned) =>
          callableValueCoercionsForExpression({
            expressionId: returned.expression,
            callablePath: returned.projections,
            requested,
            result,
            useAtExpression,
            active: nextActive,
          }),
        );
        return [...direct, ...nested];
      });
  };
  const parameterResultInvocationsForCallableExpression = ({
    expressionId,
    callablePath = [],
    callbackResult,
    callbackResultType,
    bindings,
    useAtExpression,
    active = new Set<string>(),
  }: {
    expressionId: number;
    callablePath?: readonly ResultValueProjection[];
    callbackResult: readonly PlaceProjection[];
    callbackResultType?: { moduleId: string; symbol: SymbolId };
    bindings: ReadonlyMap<SymbolId, CallableParameterInvocation>;
    useAtExpression: number;
    active?: ReadonlySet<string>;
  }): readonly {
    parameter: number;
    source: readonly ResultValueProjection[];
    callbackResult: readonly ResultValueProjection[];
    callbackResultType?: { moduleId: string; symbol: SymbolId };
  }[] => {
    const activeKey = JSON.stringify([
      expressionId,
      callablePath,
      callbackResult,
      callbackResultType,
    ]);
    if (active.has(activeKey)) {
      return [];
    }
    const nextActive = new Set(active).add(activeKey);
    const candidates = resultValueFlow.sourcesForExpression(
      expressionId,
      callablePath,
      useAtExpression,
    );
    return candidates.flatMap((candidate) => {
      const direct = directParameterInvocationForExpression({
        expressionId: candidate.expression,
        bindings,
      });
      if (direct) {
        return [
          {
            parameter: direct.parameter,
            source: [...direct.source, ...candidate.projections],
            callbackResult: valueProjectionPath(callbackResult),
            ...(callbackResultType ? { callbackResultType } : {}),
          },
        ];
      }
      const expression = hir.expressions.get(candidate.expression);
      if (
        expression?.exprKind === "call" ||
        expression?.exprKind === "method-call"
      ) {
        return callableSourcesForCallResult({
          expressionId: candidate.expression,
          requested: candidate.projections,
          useAtExpression,
        }).flatMap((source) =>
          parameterResultInvocationsForCallableExpression({
            expressionId: source.expression,
            callablePath: source.projections,
            callbackResult,
            ...(callbackResultType ? { callbackResultType } : {}),
            bindings,
            useAtExpression,
            active: nextActive,
          }),
        );
      }
      if (expression?.exprKind !== "lambda") {
        return [];
      }
      return resultValueFlow
        .resultsForCallable(expression.body)
        .flatMap((result) =>
          resultValueFlow
            .sourcesForExpression(
              result,
              valueProjectionPath(callbackResult),
              useAtExpression,
            )
            .filter((returned) => {
              if (!callbackResultType) {
                return true;
              }
              const returnedTypes = nominalOwnerRefsForType(
                returned.typeFilter ?? expressionTypeFor(returned.expression),
              );
              return (
                returnedTypes.length === 0 ||
                returnedTypes.some(
                  (type) =>
                    type.moduleId === callbackResultType.moduleId &&
                    type.symbol === callbackResultType.symbol,
                )
              );
            })
            .flatMap((returned) => {
              const returnedExpression = hir.expressions.get(
                returned.expression,
              );
              if (returnedExpression?.exprKind !== "call") {
                return [];
              }
              const returnedType =
                nominalOwnerRefsForType(returned.typeFilter)[0] ??
                callbackResultType;
              return parameterResultInvocationsForCallableExpression({
                expressionId: returnedExpression.callee,
                callbackResult: returned.projections,
                ...(returnedType ? { callbackResultType: returnedType } : {}),
                bindings,
                useAtExpression: returned.expression,
                active: nextActive,
              });
            }),
        );
    });
  };
  localFunctions.forEach((_item, symbol) => {
    const bindings = callableParameterBindings.get(symbol) ?? new Map();
    returnedCallExpressions(symbol).forEach((returned) => {
      const expression = hir.expressions.get(returned.expression);
      if (expression?.exprKind !== "call") {
        return;
      }
      parameterResultInvocationsForCallableExpression({
        expressionId: expression.callee,
        callbackResult: returned.callbackResult,
        ...(returned.callbackResultType
          ? { callbackResultType: returned.callbackResultType }
          : {}),
        bindings,
        useAtExpression: returned.expression,
      }).forEach((invocation) =>
        addCallableResultInvocation(symbol, {
          ...invocation,
          result: returned.result,
        }),
      );
    });
  });
  let callableResultChanged = true;
  while (callableResultChanged) {
    callableResultChanged = false;
    localFunctions.forEach((_item, symbol) => {
      const bindings = callableParameterBindings.get(symbol) ?? new Map();
      returnedCallExpressions(symbol).forEach((returned) => {
        const expression = hir.expressions.get(returned.expression);
        if (
          expression?.exprKind !== "call" &&
          expression?.exprKind !== "method-call"
        ) {
          return;
        }
        callTargetsFor(returned.expression).forEach((target) => {
          const targetInvocations =
            target.moduleId === moduleId
              ? Array.from(
                  callableResultInvocations.get(target.symbol)?.values() ?? [],
                )
              : (dependencyContractFor(target)?.callableResultInvocations ??
                []);
          if (targetInvocations.length === 0) {
            return;
          }
          const plans = [
            ...(typing.callArgumentPlans.get(returned.expression)?.values() ??
              []),
            ...(typing.borrowCallArgumentPlans
              .get(returned.expression)
              ?.values() ?? []),
          ];
          (plans.length > 0 ? plans : [undefined]).forEach((plan) => {
            const sources = bindCallArgumentSources({
              expression,
              plan,
              parameters: callParametersForTarget({ expression, target }),
              callerModuleId: moduleId,
              parameterModuleId: target.moduleId,
              hir,
            });
            targetInvocations.forEach((targetInvocation) => {
              const callbackResult = translateProjectionPath({
                result: targetInvocation.result,
                source: targetInvocation.callbackResult,
                requested: returned.callbackResult,
              });
              if (!callbackResult) {
                return;
              }
              const source = sources[targetInvocation.parameter];
              if (!source || source.moduleId !== moduleId) {
                return;
              }
              parameterResultInvocationsForCallableExpression({
                expressionId: source.expression,
                callablePath: [
                  ...(typeof source.field === "string"
                    ? [resultProjectionForField(source.field)]
                    : []),
                  ...valueProjectionPath(targetInvocation.source),
                ],
                callbackResult,
                ...(targetInvocation.callbackResultType
                  ? {
                      callbackResultType: targetInvocation.callbackResultType,
                    }
                  : {}),
                bindings,
                useAtExpression: returned.expression,
              }).forEach((invocation) => {
                if (
                  addCallableResultInvocation(symbol, {
                    parameter: invocation.parameter,
                    source: invocation.source,
                    callbackResult: invocation.callbackResult,
                    ...(invocation.callbackResultType
                      ? {
                          callbackResultType: invocation.callbackResultType,
                        }
                      : {}),
                    result: returned.result,
                  })
                ) {
                  callableResultChanged = true;
                }
              });
            });
          });
        });
      });
    });
  }
  const contractWithCallableResultInvocations = (
    symbol: SymbolId,
    contract: CallableBorrowContract,
  ): CallableBorrowContract => {
    const invocations = Array.from(
      callableResultInvocations.get(symbol)?.values() ?? [],
    );
    return invocations.length > 0
      ? { ...contract, callableResultInvocations: invocations }
      : contract;
  };
  const omittedParameterSetsForCall = ({
    exprId,
    target,
  }: {
    exprId: number;
    target: { moduleId: string; symbol: SymbolId };
  }): readonly ReadonlySet<number>[] => {
    const expression = hir.expressions.get(exprId);
    if (
      expression?.exprKind !== "call" &&
      expression?.exprKind !== "method-call"
    ) {
      return [];
    }
    const planned = [
      {
        targets: typing.callTargets.get(exprId),
        plans: typing.callArgumentPlans.get(exprId),
      },
      {
        targets: typing.borrowCallTargets.get(exprId),
        plans: typing.borrowCallArgumentPlans.get(exprId),
      },
    ].flatMap(({ targets, plans }) =>
      Array.from(targets?.entries() ?? [])
        .filter(
          ([, candidate]) =>
            candidate.moduleId === target.moduleId &&
            candidate.symbol === target.symbol,
        )
        .flatMap(([instanceKey]) => {
          const exact = plans?.get(instanceKey);
          const candidates = exact
            ? [exact]
            : Array.from(plans?.values() ?? []);
          return candidates.map(
            (plan) =>
              new Set(
                plan.flatMap((entry, index) =>
                  entry.kind === "omitted-default" ? [index] : [],
                ),
              ),
          );
        }),
    );
    if (planned.length > 0) {
      return planned;
    }
    return [
      new Set(
        omittedDefaultParameterIndices({
          expression,
          parameters: callParametersForTarget({
            expression,
            target,
          }),
          callerModuleId: moduleId,
          hir,
        }),
      ),
    ];
  };
  const coercionAppliesToCall = ({
    coercion,
    exprId,
    target,
  }: {
    coercion: ExportedCoercion;
    exprId: number;
    target: { moduleId: string; symbol: SymbolId };
  }): boolean => {
    if (!coercion.applicability) {
      return true;
    }
    const applicability = coercion.applicability.find(
      (candidate) =>
        candidate.callable.moduleId === target.moduleId &&
        candidate.callable.symbol === target.symbol,
    );
    if (!applicability) {
      return false;
    }
    if (!applicability.omissionRequirements) {
      return true;
    }
    const omitted = omittedParameterSetsForCall({ exprId, target });
    return omitted.some((parameters) =>
      applicability.omissionRequirements?.some((requirement) =>
        requirement.every((parameter) => parameters.has(parameter)),
      ),
    );
  };
  const resultValuesForBoundCall = ({
    arguments: callArguments,
    contract,
    omitted,
    useAtExpression,
  }: {
    arguments: readonly (ResultValueSource | undefined)[];
    contract: CallableBorrowContract;
    omitted: ReadonlySet<number>;
    useAtExpression?: number;
  }): readonly {
    expression: number;
    result: readonly ResultValueProjection[];
  }[] => {
    const valuesForParameter = (
      parameter: number,
      requested: readonly PlaceProjection[],
      active = new Set<string>(),
    ): readonly number[] => {
      const key = `${parameter}:${JSON.stringify(requested)}`;
      if (active.has(key)) {
        return [];
      }
      const nextActive = new Set(active).add(key);
      const argument = callArguments[parameter];
      const direct = argument
        ? resultValueFlow.valuesForExpression(
            argument.expression,
            [...argument.projections, ...valueProjectionPath(requested)],
            useAtExpression,
          )
        : [];
      if (!omitted.has(parameter)) {
        return direct;
      }
      const defaults =
        contract.parameters[parameter]?.defaultOrigins?.flatMap((origin) => {
          const translated = translateProjectionPath({
            result: origin.result,
            source: origin.source,
            requested,
          });
          return translated
            ? valuesForParameter(origin.parameter, translated, nextActive)
            : [];
        }) ?? [];
      return Array.from(new Set([...direct, ...defaults]));
    };
    return parameterResultOriginsForContract(contract).flatMap((origin) =>
      valuesForParameter(origin.parameter, origin.source).map((expression) => ({
        expression,
        result: valueProjectionPath(origin.result),
      })),
    );
  };
  type CallbackResultValue = {
    expression?: number;
    result?: readonly ResultValueProjection[];
    coercions?: readonly ExportedCoercion[];
  };
  const callableResultValuesForExpression = ({
    expressionId,
    callablePath = [],
    callbackResult,
    callbackResultType,
    result,
    useAtExpression,
  }: {
    expressionId: number;
    callablePath?: readonly ResultValueProjection[];
    callbackResult: readonly PlaceProjection[];
    callbackResultType?: { moduleId: string; symbol: SymbolId };
    result: readonly PlaceProjection[];
    useAtExpression: number;
  }): readonly CallbackResultValue[] => {
    const callbackResultsForBody = (
      body: number,
    ): readonly CallbackResultValue[] =>
      resultValueFlow.resultsForCallable(body).flatMap((returned) =>
        resultValueFlow
          .sourcesForExpression(
            returned,
            valueProjectionPath(callbackResult),
            useAtExpression,
          )
          .filter((source) => {
            if (!callbackResultType) {
              return true;
            }
            const candidates = nominalOwnerRefsForType(
              source.typeFilter ?? expressionTypeFor(source.expression),
            );
            return (
              candidates.length === 0 ||
              candidates.some(
                (candidate) =>
                  candidate.moduleId === callbackResultType.moduleId &&
                  candidate.symbol === callbackResultType.symbol,
              )
            );
          })
          .map((source) => ({
            expression: source.expression,
            result: valueProjectionPath(result),
          })),
      );
    const values = callableValueSourcesForExpression({
      expressionId,
      callablePath,
      useAtExpression,
    }).flatMap((source): readonly CallbackResultValue[] => {
      const expression = hir.expressions.get(source.expression);
      if (expression?.exprKind === "lambda") {
        return callbackResultsForBody(expression.body);
      }
      if (expression?.exprKind !== "identifier") {
        return [];
      }
      const callable = localFunctions.get(expression.symbol);
      if (callable) {
        return callbackResultsForBody(callable.body);
      }
      const target = canonicalRef(expression.symbol);
      if (target.moduleId === moduleId) {
        return [];
      }
      const coercions = Array.from(
        dependencyExports.get(target.moduleId)?.values() ?? [],
      )
        .filter(
          (entry) =>
            entry.symbol === target.symbol ||
            entry.symbols?.includes(target.symbol) === true,
        )
        .flatMap((entry) => entry.borrowingCoercions ?? [])
        .filter((coercion) => traitIsPublic(coercion.trait))
        .filter(
          (coercion) =>
            !coercion.applicability ||
            coercion.applicability.some(
              (applicability) =>
                applicability.callable.moduleId === target.moduleId &&
                applicability.callable.symbol === target.symbol,
            ),
        )
        .map((coercion) => {
          const { applicability: _applicability, ...resolved } = coercion;
          return translatedCoercionReachability({
            coercion: resolved,
            requested: callbackResult,
            result,
            requestedTypes: callbackResultType ? [callbackResultType] : [],
          });
        })
        .filter(
          (coercion): coercion is ExportedCoercion => coercion !== undefined,
        );
      return coercions.length > 0 ? [{ coercions }] : [];
    });
    const coercions = callableValueCoercionsForExpression({
      expressionId,
      callablePath,
      requested: callbackResult,
      result,
      useAtExpression,
    });
    return coercions.length > 0 ? [{ coercions }, ...values] : values;
  };
  const callbackResultValuesForBoundCall = ({
    target,
    arguments: callArguments,
    useAtExpression,
  }: {
    target: { moduleId: string; symbol: SymbolId };
    arguments: readonly (ResultValueSource | undefined)[];
    useAtExpression?: number;
  }): readonly CallbackResultValue[] => {
    const invocations =
      target.moduleId === moduleId
        ? Array.from(
            callableResultInvocations.get(target.symbol)?.values() ?? [],
          )
        : (dependencyContractFor(target)?.callableResultInvocations ?? []);
    return invocations.flatMap((invocation) => {
      const argument = callArguments[invocation.parameter];
      if (!argument) {
        return [];
      }
      const requested = [
        ...argument.projections,
        ...valueProjectionPath(invocation.source),
      ];
      return callableResultValuesForExpression({
        expressionId: argument.expression,
        callablePath: requested,
        callbackResult: invocation.callbackResult,
        ...(invocation.callbackResultType
          ? { callbackResultType: invocation.callbackResultType }
          : {}),
        result: invocation.result,
        useAtExpression: useAtExpression ?? argument.expression,
      });
    });
  };
  const callResultValues = (
    exprId: number,
    useAtExpression?: number,
  ): readonly {
    expression?: number;
    result?: readonly ResultValueProjection[];
    coercions?: readonly ExportedCoercion[];
  }[] => {
    const expression = hir.expressions.get(exprId);
    if (
      expression?.exprKind !== "call" &&
      expression?.exprKind !== "method-call"
    ) {
      return [];
    }
    const resolved = [
      {
        targets: typing.callTargets.get(exprId),
        plans: typing.callArgumentPlans.get(exprId),
      },
      {
        targets: typing.borrowCallTargets.get(exprId),
        plans: typing.borrowCallArgumentPlans.get(exprId),
      },
    ].flatMap(({ targets, plans }) =>
      Array.from(targets?.entries() ?? []).flatMap(([instanceKey, target]) => {
        const contract =
          target.moduleId === moduleId
            ? borrowing.callables.get(target.symbol)
            : dependencyContractFor(target);
        if (!contract) {
          return [];
        }
        const directPlan = plans?.get(instanceKey);
        const candidatePlans = directPlan
          ? [directPlan]
          : plans && plans.size > 0
            ? Array.from(plans.values())
            : [undefined];
        const parameters = callParametersForTarget({
          expression,
          target,
        });
        return candidatePlans.flatMap((plan) => {
          const callArguments = resultValueSources(
            bindCallArgumentSources({
              expression,
              plan,
              parameters:
                target.moduleId === moduleId
                  ? localCallParameters.get(target.symbol)
                  : undefined,
              callerModuleId: moduleId,
              parameterModuleId: target.moduleId,
              hir,
            }),
          );
          return [
            ...resultValuesForBoundCall({
              arguments: callArguments,
              contract,
              useAtExpression,
              omitted: new Set(
                omittedDefaultParameterIndices({
                  expression,
                  plan,
                  parameters,
                  callerModuleId: moduleId,
                  hir,
                }),
              ),
            }),
            ...callbackResultValuesForBoundCall({
              target,
              arguments: callArguments,
              useAtExpression,
            }),
          ];
        });
      }),
    );
    const resolvedTargetKeys = new Set(
      [
        ...(typing.callTargets.get(exprId)?.values() ?? []),
        ...(typing.borrowCallTargets.get(exprId)?.values() ?? []),
      ].map((target) => `${target.moduleId}:${target.symbol}`),
    );
    const direct = callTargetsFor(exprId)
      .filter(
        (target) =>
          !resolvedTargetKeys.has(`${target.moduleId}:${target.symbol}`),
      )
      .flatMap((target) => {
        const contract =
          target.moduleId === moduleId
            ? borrowing.callables.get(target.symbol)
            : dependencyContractFor(target);
        if (!contract) {
          return [];
        }
        const parameters = callParametersForTarget({
          expression,
          target,
        });
        const plans = [
          ...(typing.callArgumentPlans.get(exprId)?.values() ?? []),
          ...(typing.borrowCallArgumentPlans.get(exprId)?.values() ?? []),
        ];
        return (plans.length > 0 ? plans : [undefined]).flatMap((plan) => {
          const callArguments = resultValueSources(
            bindCallArgumentSources({
              expression,
              plan,
              parameters,
              callerModuleId: moduleId,
              parameterModuleId: target.moduleId,
              hir,
            }),
          );
          return [
            ...resultValuesForBoundCall({
              arguments: callArguments,
              contract,
              useAtExpression,
              omitted: new Set(
                omittedDefaultParameterIndices({
                  expression,
                  plan,
                  parameters,
                  callerModuleId: moduleId,
                  hir,
                }),
              ),
            }),
            ...callbackResultValuesForBoundCall({
              target,
              arguments: callArguments,
              useAtExpression,
            }),
          ];
        });
      });
    return [...resolved, ...direct];
  };
  type LocalResultCall = {
    symbol: SymbolId;
    requested: readonly PlaceProjection[];
    result: readonly PlaceProjection[];
    requestedTypes: readonly { moduleId: string; symbol: SymbolId }[];
    resultType?: { moduleId: string; symbol: SymbolId };
  };
  type ResultExposure = {
    coercions: Map<string, ExportedCoercion>;
    localCalls: Map<string, LocalResultCall>;
    widenResultPaths: boolean;
  };
  const resultExposureForExpression = (
    exprId: number,
    targetType: TypeId | undefined,
    active = new Set<string>(),
    useAtExpression?: number,
    resultPath: readonly PlaceProjection[] = [],
    requestedPath: readonly PlaceProjection[] = [],
    resultType?: { moduleId: string; symbol: SymbolId },
    requestedTypes: readonly { moduleId: string; symbol: SymbolId }[] = [],
  ): ResultExposure => {
    const exposure: ResultExposure = {
      coercions: new Map(),
      localCalls: new Map(),
      widenResultPaths: false,
    };
    const inferredResultTypes =
      !resultType && typeIsVariantUnion(targetType)
        ? nominalOwnerRefsForType(expressionTypeFor(exprId))
        : [];
    const currentResultType =
      resultType ??
      (inferredResultTypes.length === 1 ? inferredResultTypes[0] : undefined);
    const cycleKey = JSON.stringify([
      "result-exposure-cycle",
      exprId,
      targetType,
      currentResultType,
      requestedTypes,
    ]);
    if (active.has(cycleKey)) {
      exposure.widenResultPaths = true;
      return exposure;
    }
    active.add(cycleKey);
    const activeKey = JSON.stringify([
      exprId,
      resultPath,
      requestedPath,
      currentResultType,
      requestedTypes,
    ]);
    if (active.has(activeKey)) {
      return exposure;
    }
    active.add(activeKey);
    const widenedCoercion = (coercion: ExportedCoercion): ExportedCoercion => {
      const {
        resultPaths: _resultPaths,
        resultType: _resultType,
        ...reachable
      } = coercion;
      return reachable;
    };
    const addCoercion = (coercion: ExportedCoercion): void => {
      const reachable = exposure.widenResultPaths
        ? widenedCoercion(coercion)
        : coercion;
      const key = coercionKey(reachable);
      const existing = exposure.coercions.get(key);
      exposure.coercions.set(
        key,
        existing
          ? (mergeCoercionReachability([existing, reachable])[0] ?? reachable)
          : reachable,
      );
    };
    const widenReachableCoercions = (): void => {
      if (exposure.widenResultPaths) {
        return;
      }
      exposure.widenResultPaths = true;
      const widened = mergeCoercionReachability(
        Array.from(exposure.coercions.values(), widenedCoercion),
      );
      exposure.coercions.clear();
      widened.forEach((coercion) =>
        exposure.coercions.set(coercionKey(coercion), coercion),
      );
    };
    const addExposure = (nested: ResultExposure): void => {
      if (nested.widenResultPaths) {
        widenReachableCoercions();
      }
      nested.coercions.forEach(addCoercion);
      nested.localCalls.forEach((call, key) =>
        exposure.localCalls.set(key, call),
      );
    };
    const exposureSourcesForExpression = (
      expression: number,
      projections: readonly ResultValueProjection[],
    ): readonly ResultValueSource[] => {
      const flow = resultValueFlow.sourceFlowForExpression(
        expression,
        projections,
        useAtExpression,
      );
      if (flow.recursive) {
        widenReachableCoercions();
      }
      return flow.sources;
    };
    const nestedExposure = (
      expression: number,
      type: TypeId | undefined,
      nestedResultPath = resultPath,
      nestedRequestedPath: readonly PlaceProjection[] = [],
      nestedResultType = currentResultType,
      nestedRequestedTypes: readonly {
        moduleId: string;
        symbol: SymbolId;
      }[] = [],
    ): ResultExposure =>
      resultExposureForExpression(
        expression,
        type,
        new Set(active),
        useAtExpression,
        nestedResultPath,
        nestedRequestedPath,
        nestedResultType,
        nestedRequestedTypes,
      );
    directCoercionsForTypes(expressionTypeFor(exprId), targetType).forEach(
      (coercion) =>
        addCoercion({
          ...coercion,
          resultPaths: [resultPath],
          ...(currentResultType ? { resultType: currentResultType } : {}),
        }),
    );
    const expression = hir.expressions.get(exprId);
    if (!expression) {
      return exposure;
    }
    if (expression.exprKind === "identifier") {
      const resultProjections = resultProjectionsForType(targetType);
      if (resultProjections.length === 0) {
        const sources = exposureSourcesForExpression(
          exprId,
          valueProjectionPath(requestedPath),
        );
        sources.forEach((source) =>
          addExposure(
            nestedExposure(
              source.expression,
              targetType,
              resultPath,
              source.projections,
              currentResultType,
              nominalOwnerRefsForType(source.typeFilter),
            ),
          ),
        );
      }
      resultProjections.forEach((projection) => {
        projectedTypes(
          targetType ?? typing.primitives.unknown,
          [projection],
          typing,
        ).forEach((nestedTarget) =>
          exposureSourcesForExpression(exprId, [
            ...valueProjectionPath(requestedPath),
            projection,
          ]).forEach((source) =>
            addExposure(
              nestedExposure(
                source.expression,
                nestedTarget,
                [...resultPath, projection],
                source.projections,
                currentResultType,
                nominalOwnerRefsForType(source.typeFilter),
              ),
            ),
          ),
        );
      });
      return exposure;
    }
    if (expression.exprKind === "block") {
      if (typeof expression.value === "number") {
        addExposure(nestedExposure(expression.value, targetType));
      }
      return exposure;
    }
    if (expression.exprKind === "if" || expression.exprKind === "cond") {
      expression.branches.forEach((branch) =>
        addExposure(nestedExposure(branch.value, targetType)),
      );
      if (typeof expression.defaultBranch === "number") {
        addExposure(nestedExposure(expression.defaultBranch, targetType));
      }
      return exposure;
    }
    if (expression.exprKind === "match") {
      expression.arms.forEach((arm) =>
        addExposure(nestedExposure(arm.value, targetType)),
      );
      return exposure;
    }
    if (expression.exprKind === "tuple") {
      expression.elements.forEach((element, index) =>
        projectedTypes(
          targetType ?? typing.primitives.unknown,
          [{ kind: "tuple", index }],
          typing,
        ).forEach((nestedTarget) =>
          addExposure(
            nestedExposure(element, nestedTarget, [
              ...resultPath,
              { kind: "tuple", index },
            ]),
          ),
        ),
      );
      return exposure;
    }
    if (expression.exprKind === "object-literal") {
      resultProjectionsForType(targetType).forEach((projection) => {
        projectedTypes(
          targetType ?? typing.primitives.unknown,
          [projection],
          typing,
        ).forEach((nestedTarget) =>
          exposureSourcesForExpression(exprId, [projection]).forEach((source) =>
            addExposure(
              nestedExposure(
                source.expression,
                nestedTarget,
                [...resultPath, projection],
                source.projections,
                currentResultType,
                nominalOwnerRefsForType(source.typeFilter),
              ),
            ),
          ),
        );
      });
      return exposure;
    }
    if (expression.exprKind === "field-access") {
      const sources = exposureSourcesForExpression(
        exprId,
        valueProjectionPath(requestedPath),
      );
      sources.forEach((source) =>
        addExposure(
          nestedExposure(
            source.expression,
            targetType,
            resultPath,
            source.projections,
            currentResultType,
            nominalOwnerRefsForType(source.typeFilter),
          ),
        ),
      );
      return exposure;
    }
    if (expression.exprKind === "assign") {
      addExposure(nestedExposure(expression.value, targetType));
      return exposure;
    }
    if (expression.exprKind === "effect-handler") {
      [
        expression.body,
        ...expression.handlers.map((handler) => handler.body),
      ].forEach((value) => addExposure(nestedExposure(value, targetType)));
      return exposure;
    }
    if (expression.exprKind === "loop") {
      walkExpression({
        exprId: expression.body,
        hir,
        options: { skipLambdas: true },
        onEnterExpression: (_nestedId, nested) => {
          if (nested.exprKind === "break" && typeof nested.value === "number") {
            addExposure(nestedExposure(nested.value, targetType));
          }
        },
      });
      return exposure;
    }
    if (expression.exprKind === "break") {
      if (typeof expression.value === "number") {
        addExposure(nestedExposure(expression.value, targetType));
      }
      return exposure;
    }
    if (
      expression.exprKind === "call" ||
      expression.exprKind === "method-call"
    ) {
      const returnedValues = typeCanExposePublicTrait(targetType)
        ? callResultValues(exprId, useAtExpression)
        : [];
      returnedValues.forEach((returned) => {
        if (returned.coercions) {
          returned.coercions.forEach(addCoercion);
          return;
        }
        if (typeof returned.expression !== "number") {
          return;
        }
        const result = returned.result ?? [];
        const nestedTargets =
          result.length === 0
            ? [targetType ?? typing.primitives.unknown]
            : projectedTypes(
                targetType ?? typing.primitives.unknown,
                result,
                typing,
              );
        const returnedExpression = returned.expression;
        nestedTargets.forEach((nestedTarget) =>
          addExposure(
            nestedExposure(
              returnedExpression,
              nestedTarget,
              result.length === 0 ? resultPath : [...resultPath, ...result],
            ),
          ),
        );
      });
      const targets = callTargetsFor(exprId);
      targets.forEach((target) => {
        if (target.moduleId === moduleId) {
          const call = {
            symbol: target.symbol,
            requested: requestedPath,
            result: resultPath,
            requestedTypes,
            resultType: currentResultType,
          };
          exposure.localCalls.set(JSON.stringify(call), call);
          return;
        }
        Array.from(dependencyExports.get(target.moduleId)?.values() ?? [])
          .filter(
            (entry) =>
              entry.symbol === target.symbol ||
              entry.symbols?.includes(target.symbol) === true,
          )
          .flatMap((entry) => entry.borrowingCoercions ?? [])
          .filter((coercion) => traitIsPublic(coercion.trait))
          .filter((coercion) =>
            coercionAppliesToCall({ coercion, exprId, target }),
          )
          .forEach((coercion) => {
            const { applicability: _applicability, ...resolved } = coercion;
            const translated = translatedCoercionReachability({
              coercion: resolved,
              requested: requestedPath,
              result: resultPath,
              requestedTypes,
              resultType: currentResultType,
            });
            if (translated) {
              addCoercion(translated);
            }
          });
      });
      if (expression.exprKind === "call") {
        callableValueCoercionsForExpression({
          expressionId: expression.callee,
          requested: requestedPath,
          result: resultPath,
          useAtExpression: useAtExpression ?? exprId,
        }).forEach(addCoercion);
        const callee = hir.expressions.get(expression.callee);
        const lambdaValues =
          callee?.exprKind === "lambda"
            ? [{ expression: expression.callee, projections: [] }]
            : callee?.exprKind === "identifier"
              ? callableValueSourcesForExpression({
                  expressionId: expression.callee,
                  useAtExpression: useAtExpression ?? exprId,
                })
              : [];
        lambdaValues.forEach((value) => {
          const lambda = hir.expressions.get(value.expression);
          if (lambda?.exprKind === "lambda") {
            resultValueFlow
              .resultsForCallable(lambda.body)
              .forEach((result) =>
                addExposure(
                  resultExposureForExpression(
                    result,
                    targetType,
                    new Set(active),
                    useAtExpression ?? exprId,
                    resultPath,
                    requestedPath,
                    currentResultType,
                    requestedTypes,
                  ),
                ),
              );
          }
        });
      }
    }
    return exposure;
  };
  const resultExposures = new Map<SymbolId, ResultExposure>();
  const defaultResultCoercionsFor = (
    symbol: SymbolId,
  ): readonly ExportedCoercion[] => {
    const item = Array.from(hir.items.values()).find(
      (candidate) =>
        candidate.kind === "function" && candidate.symbol === symbol,
    );
    const contract = borrowing.callables.get(symbol);
    const returnType = typing.functions.getSignature(symbol)?.returnType;
    if (item?.kind !== "function" || !contract) {
      return [];
    }
    const coercions: ExportedCoercion[] = [];
    const defaultValuesForParameter = (
      parameter: number,
      requested: readonly PlaceProjection[],
      requirements: ReadonlySet<number>,
      active = new Set<string>(),
    ): readonly {
      expression: number;
      requirements: readonly number[];
    }[] => {
      const key = `${parameter}:${JSON.stringify(requested)}`;
      const defaultValue = item.parameters[parameter]?.defaultValue;
      if (active.has(key) || typeof defaultValue !== "number") {
        return [];
      }
      const nextActive = new Set(active).add(key);
      const direct = resultValueFlow
        .valuesForExpression(defaultValue, valueProjectionPath(requested))
        .map((expression) => ({
          expression,
          requirements: Array.from(requirements).sort(
            (left, right) => left - right,
          ),
        }));
      const nested =
        contract.parameters[parameter]?.defaultOrigins?.flatMap((origin) => {
          const translated = translateProjectionPath({
            result: origin.result,
            source: origin.source,
            requested,
          });
          if (!translated) {
            return [];
          }
          return defaultValuesForParameter(
            origin.parameter,
            translated,
            new Set(requirements).add(origin.parameter),
            nextActive,
          );
        }) ?? [];
      return [...direct, ...nested];
    };
    parameterResultOriginsForContract(contract).forEach((origin) => {
      defaultValuesForParameter(
        origin.parameter,
        origin.source,
        new Set([origin.parameter]),
      ).forEach((returned) => {
        const result = valueProjectionPath(origin.result);
        const nestedTargets =
          result.length === 0
            ? [returnType ?? typing.primitives.unknown]
            : projectedTypes(
                returnType ?? typing.primitives.unknown,
                result,
                typing,
              );
        nestedTargets.forEach((nestedTarget) => {
          resultExposureForExpression(
            returned.expression,
            nestedTarget,
            new Set(),
            undefined,
            result,
          ).coercions.forEach((coercion) =>
            coercions.push({
              ...coercion,
              applicability: [
                {
                  callable: { moduleId, symbol },
                  omissionRequirements: [returned.requirements],
                },
              ],
            }),
          );
        });
      });
    });
    Array.from(callableResultInvocations.get(symbol)?.values() ?? []).forEach(
      (invocation) => {
        const defaultValue =
          item.parameters[invocation.parameter]?.defaultValue;
        if (typeof defaultValue !== "number") {
          return;
        }
        const argumentsForDefault: (ResultValueSource | undefined)[] = Array(
          item.parameters.length,
        ).fill(undefined);
        argumentsForDefault[invocation.parameter] = {
          expression: defaultValue,
          projections: [],
        };
        callbackResultValuesForBoundCall({
          target: { moduleId, symbol },
          arguments: argumentsForDefault,
          useAtExpression: defaultValue,
        }).forEach((returned) => {
          const addDefaultCoercion = (coercion: ExportedCoercion): void => {
            coercions.push({
              ...coercion,
              applicability: [
                {
                  callable: { moduleId, symbol },
                  omissionRequirements: [[invocation.parameter]],
                },
              ],
            });
          };
          if (returned.coercions) {
            returned.coercions.forEach(addDefaultCoercion);
            return;
          }
          if (typeof returned.expression !== "number") {
            return;
          }
          const returnedExpression = returned.expression;
          const result = returned.result ?? [];
          const nestedTargets =
            result.length === 0
              ? [returnType ?? typing.primitives.unknown]
              : projectedTypes(
                  returnType ?? typing.primitives.unknown,
                  result,
                  typing,
                );
          nestedTargets.forEach((nestedTarget) =>
            resultExposureForExpression(
              returnedExpression,
              nestedTarget,
              new Set(),
              undefined,
              result,
            ).coercions.forEach(addDefaultCoercion),
          );
        });
      },
    );
    return mergeCoercionReachability(coercions);
  };
  const defaultCallableResultCoercionCache = new Map<
    SymbolId,
    readonly ExportedCoercion[]
  >();
  const activeDefaultCallableResultCoercions = new Set<SymbolId>();
  defaultCallableResultCoercionsFor = (
    symbol: SymbolId,
  ): readonly ExportedCoercion[] => {
    const cached = defaultCallableResultCoercionCache.get(symbol);
    if (cached) {
      return cached;
    }
    if (activeDefaultCallableResultCoercions.has(symbol)) {
      return [];
    }
    const item = localFunctions.get(symbol);
    const contract = borrowing.callables.get(symbol);
    const signature = typing.functions.getSignature(symbol);
    if (!item || !contract || !signature) {
      defaultCallableResultCoercionCache.set(symbol, []);
      return [];
    }
    activeDefaultCallableResultCoercions.add(symbol);
    const coercions = parameterResultOriginsForContract(contract).flatMap(
      (origin) => {
        const defaultValue = item.parameters[origin.parameter]?.defaultValue;
        if (typeof defaultValue !== "number") {
          return [];
        }
        const returnedCallableTypes = projectedTypes(
          signature.returnType,
          valueProjectionPath(origin.result),
          typing,
        ).filter((type) => callableReturnTypesForType(type).length > 0);
        if (returnedCallableTypes.length === 0) {
          return [];
        }
        const callbackTypes = projectedTypes(
          signature.parameters[origin.parameter]?.type ??
            typing.primitives.unknown,
          valueProjectionPath(origin.source),
          typing,
        );
        const callbackReturnTypes = callbackTypes.flatMap((type) =>
          callableReturnTypesForType(type),
        );
        return callbackReturnTypes.flatMap((returnType) =>
          callableResultValuesForExpression({
            expressionId: defaultValue,
            callablePath: valueProjectionPath(origin.source),
            callbackResult: [],
            ...(nominalOwnerRefsForType(returnType)[0]
              ? {
                  callbackResultType: nominalOwnerRefsForType(returnType)[0]!,
                }
              : {}),
            result: [],
            useAtExpression: defaultValue,
          }).flatMap((returned) => {
            const resolved =
              returned.coercions ??
              (typeof returned.expression === "number"
                ? Array.from(
                    resultExposureForExpression(
                      returned.expression,
                      returnType,
                      new Set(),
                      defaultValue,
                      returned.result ?? [],
                    ).coercions.values(),
                  )
                : []);
            return resolved.map((coercion) => ({
              ...coercion,
              ...(coercion.resultPaths
                ? {
                    resultPaths: coercion.resultPaths.map((path) =>
                      redactPrivateSummaryPath(
                        path,
                        privateFieldProjection(returnType, path),
                      ),
                    ),
                  }
                : {}),
              applicability: [
                {
                  callable: { moduleId, symbol },
                  omissionRequirements: [[origin.parameter]],
                },
              ],
            }));
          }),
        );
      },
    );
    const merged = mergeCoercionReachability(coercions);
    activeDefaultCallableResultCoercions.delete(symbol);
    defaultCallableResultCoercionCache.set(symbol, merged);
    return merged;
  };
  Array.from(hir.items.values()).forEach((item) => {
    if (item.kind === "module-let") {
      resultExposures.set(
        item.symbol,
        resultExposureForExpression(
          item.initializer,
          typing.valueTypes.get(item.symbol),
        ),
      );
      return;
    }
    if (item.kind !== "function") {
      return;
    }
    const returnType = typing.functions.getSignature(item.symbol)?.returnType;
    const exposure: ResultExposure = {
      coercions: new Map(),
      localCalls: new Map(),
      widenResultPaths: false,
    };
    resultValueFlow.resultsForCallable(item.body).forEach((result) => {
      const returned = resultExposureForExpression(result, returnType);
      returned.coercions.forEach((coercion, key) =>
        exposure.coercions.set(key, coercion),
      );
      returned.localCalls.forEach((call, key) =>
        exposure.localCalls.set(key, call),
      );
    });
    resultExposures.set(item.symbol, exposure);
  });
  let resultExposureChanged = true;
  while (resultExposureChanged) {
    resultExposureChanged = false;
    resultExposures.forEach((exposure) => {
      exposure.localCalls.forEach((call) => {
        resultExposures.get(call.symbol)?.coercions.forEach((coercion) => {
          const translated = translatedCoercionReachability({
            coercion,
            requested: call.requested,
            result: call.result,
            requestedTypes: call.requestedTypes,
            resultType: call.resultType,
          });
          if (!translated) {
            return;
          }
          const key = coercionKey(translated);
          if (exposure.coercions.has(key)) {
            return;
          }
          exposure.coercions.set(key, translated);
          resultExposureChanged = true;
        });
      });
    });
  }
  const coercionsFor = (
    symbol: SymbolId,
  ): NonNullable<ModuleExportEntry["borrowingCoercions"]> => {
    const callable = typing.functions.getSignature(symbol) !== undefined;
    const privacy = callable ? borrowSummaryPrivacyFor(symbol) : undefined;
    const publicResultPaths = (coercion: ExportedCoercion): ExportedCoercion =>
      privacy && coercion.resultPaths
        ? {
            ...coercion,
            resultPaths: coercion.resultPaths.map((path) =>
              redactPrivateSummaryPath(
                path,
                privacy.privateResultProjection(path),
              ),
            ),
          }
        : coercion;
    const resultCoercions = Array.from(
      resultExposures.get(symbol)?.coercions.values() ?? [],
    )
      .map(publicResultPaths)
      .map((coercion) =>
        callable
          ? {
              ...coercion,
              applicability: [{ callable: { moduleId, symbol } }],
            }
          : coercion,
      );
    const defaultResultCoercions =
      defaultResultCoercionsFor(symbol).map(publicResultPaths);
    const concreteCoercions = Array.from(localCoercions.values()).filter(
      (coercion) =>
        coercion.concrete.moduleId === moduleId &&
        coercion.concrete.symbol === symbol &&
        traitIsPublic(coercion.trait),
    );
    return mergeCoercionReachability([
      ...resultCoercions,
      ...defaultResultCoercions,
      ...concreteCoercions,
    ]);
  };
  const traitImplementationsFor = (
    symbol: SymbolId,
  ): NonNullable<ModuleExportTable["borrowingTraitImplementations"]> =>
    Array.from(coercionProjectionGroups.values()).flatMap((projections) => {
      const first = projections[0];
      if (
        !first ||
        first.concrete.moduleId !== moduleId ||
        first.concrete.symbol !== symbol
      ) {
        return [];
      }
      const methods = Array.from(
        new Set(projections.flatMap((entry) => entry.implementationMethods)),
      ).flatMap((implementation) => {
        const mapping = typing.traitMethodImpls.get(implementation);
        if (!mapping) {
          return [];
        }
        const declaration = canonicalRef(mapping.traitMethodSymbol);
        const serialized =
          declaration.moduleId === moduleId
            ? (() => {
                const contract = borrowing.callables.get(
                  mapping.traitMethodSymbol,
                );
                if (!contract) {
                  return undefined;
                }
                return serializeCallableBorrowSummary({
                  contract: contractWithCallableResultInvocations(
                    mapping.traitMethodSymbol,
                    contract,
                  ),
                  namedContract: borrowing.namedContracts.get(
                    mapping.traitMethodSymbol,
                  ),
                  dispatchHint: "trait-declaration",
                });
              })()
            : Array.from(
                dependencyExports.get(declaration.moduleId)?.values() ?? [],
              )
                .flatMap((entry) => entry.borrowing ?? [])
                .find((entry) => entry.symbol === declaration.symbol)
                ?.serialized;
        if (!serialized) {
          return [];
        }
        return [
          {
            implementation: { moduleId, symbol: implementation },
            declaration,
            serialized,
            serializedBytes: callableBorrowSummarySize(serialized),
            contract: deserializeCallableBorrowSummary(serialized).contract,
          },
        ];
      });
      return methods.length > 0
        ? [
            {
              concrete: first.concrete,
              trait: first.trait,
              implementation: first.implementation,
              methods,
            },
          ]
        : [];
    });
  const importedExportFor = (
    symbol: SymbolId,
  ): ModuleExportEntry | undefined => {
    const target = imports.get(symbol);
    if (!target) {
      return undefined;
    }
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
    const importedExport = importedExportFor(symbol);
    const borrowingCoercions = mergeCoercionReachability([
      ...(existing?.borrowingCoercions ?? []),
      ...(importedExport?.borrowingCoercions ?? []).filter((coercion) =>
        traitIsPublic(coercion.trait),
      ),
      ...coercionsFor(symbol),
    ]);
    const borrowingCallableResultCoercions = mergeCoercionReachability([
      ...(existing?.borrowingCallableResultCoercions ?? []),
      ...(importedExport?.borrowingCallableResultCoercions ?? []).filter(
        (coercion) => traitIsPublic(coercion.trait),
      ),
      ...defaultCallableResultCoercionsFor(symbol),
    ]);
    const borrowingContracts = new Map(
      [
        ...(existing?.borrowing ?? []),
        ...(importedExport?.borrowing?.map((entry) => ({
          ...entry,
          symbol,
        })) ?? []),
      ].map((entry) => [entry.symbol, entry]),
    );
    const addBorrowingSummary = (callableSymbol: SymbolId): void => {
      const borrowContract = borrowing.callables.get(callableSymbol);
      if (!borrowContract) {
        return;
      }
      const serialized = serializeCallableBorrowSummary({
        contract: contractWithCallableResultInvocations(
          callableSymbol,
          borrowContract,
        ),
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
      ...(borrowingCoercions.length > 0 ? { borrowingCoercions } : {}),
      ...(borrowingCallableResultCoercions.length > 0
        ? { borrowingCallableResultCoercions }
        : {}),
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
  const localTraitImplementations = Array.from(
    new Set(
      Array.from(coercionProjectionGroups.values()).flatMap((projections) => {
        const concrete = projections[0]?.concrete;
        return concrete?.moduleId === moduleId ? [concrete.symbol] : [];
      }),
    ),
  ).flatMap(traitImplementationsFor);
  const exportedCoercions = Array.from(table.values()).flatMap(
    (entry) => entry.borrowingCoercions ?? [],
  );
  const isExportedImplementation = (
    implementation: NonNullable<
      ModuleExportTable["borrowingTraitImplementations"]
    >[number],
  ): boolean =>
    exportedCoercions.some(
      (coercion) =>
        coercion.concrete.moduleId === implementation.concrete.moduleId &&
        coercion.concrete.symbol === implementation.concrete.symbol &&
        coercion.trait.moduleId === implementation.trait.moduleId &&
        coercion.trait.symbol === implementation.trait.symbol &&
        coercion.implementation.moduleId ===
          implementation.implementation.moduleId &&
        coercion.implementation.symbol === implementation.implementation.symbol,
    );
  const importedTraitImplementations = Array.from(
    new Set(Array.from(imports.values(), (target) => target.moduleId)),
  )
    .flatMap(
      (dependency) =>
        dependencyExports.get(dependency)?.borrowingTraitImplementations ?? [],
    )
    .filter(isExportedImplementation);
  const publicTraitImplementations = Array.from(
    new Map(
      [
        ...localTraitImplementations.filter(isExportedImplementation),
        ...importedTraitImplementations.filter(isExportedImplementation),
      ].map((implementation) => [
        JSON.stringify([
          implementation.concrete,
          implementation.trait,
          implementation.implementation,
          implementation.methods.map((method) => [
            method.implementation,
            method.declaration,
            method.serialized,
          ]),
        ]),
        implementation,
      ]),
    ).values(),
  );
  if (publicTraitImplementations.length > 0) {
    table.borrowingTraitImplementations = publicTraitImplementations;
  }

  if (isCompilerPerfEnabled()) {
    const retainedBorrowingSummaryBytes =
      Array.from(table.values()).reduce(
        (total, entry) =>
          total +
          (entry.borrowing ?? []).reduce(
            (sum, summary) => sum + (summary.serializedBytes ?? 0),
            0,
          ) +
          (entry.borrowingCoercions ?? []).reduce(
            (sum, summary) => sum + summary.serializedBytes,
            0,
          ) +
          (entry.borrowingCallableResultCoercions ?? []).reduce(
            (sum, summary) => sum + summary.serializedBytes,
            0,
          ),
        0,
      ) +
      (table.borrowingTraitImplementations ?? []).reduce(
        (total, implementation) =>
          total +
          implementation.methods.reduce(
            (sum, method) => sum + method.serializedBytes,
            0,
          ),
        0,
      );
    incrementCompilerPerfCounter(
      "borrowing.summary.retainedBytes",
      retainedBorrowingSummaryBytes,
    );
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
