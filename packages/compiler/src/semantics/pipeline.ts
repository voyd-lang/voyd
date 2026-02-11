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
import { toSourceSpan } from "./utils.js";
import type { OverloadSetId, SourceSpan, SymbolId } from "./ids.js";
import type { ModuleExportEffect, ModuleExportTable } from "./modules.js";
import type { DependencySemantics } from "./typing/types.js";
import type { Diagnostic } from "../diagnostics/index.js";
import { DiagnosticError, diagnosticFromCode } from "../diagnostics/index.js";
import {
  buildModuleSymbolIndex,
  type ModuleSymbolIndex,
} from "./symbol-index.js";
import { getSymbolTable } from "./_internal/symbol-table.js";
import { assignModuleTestIds, isGeneratedTestId } from "../tests/ids.js";
import { formatEffectRow } from "./effects/format.js";

export interface SemanticsPipelineResult {
  binding: BindingResult;
  symbols: ModuleSymbolIndex;
  hir: HirGraph;
  typing: TypingResult;
  moduleId: string;
  exports: ModuleExportTable;
  diagnostics: readonly Diagnostic[];
}

export interface SemanticsPipelineOptions {
  module: ModuleNode;
  graph: ModuleGraph;
  exports?: Map<string, ModuleExportTable>;
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
    dependencies,
    typing: typingState,
    recoverFromTypingErrors,
  } = normalizeSemanticsInput(input);
  const form = module.ast;
  if (!form.callsInternal("ast")) {
    throw new Error("semantics pipeline expects the expanded AST root form");
  }

  assignModuleTestIds({ ast: form, modulePath: module.path });

  const modulePath = form.location?.filePath ?? "<module>";
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
  const exportsTable = collectModuleExports({
    hir,
    symbolTable,
    moduleId: module.id,
    modulePath: module.path,
    packageId: binding.packageId,
    binding,
    typing,
  });

  const diagnostics: Diagnostic[] = [
    ...binding.diagnostics,
    ...typing.diagnostics,
    ...enforcePkgRootEffectRules({ binding, hir, typing, symbolTable }),
  ];

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
}: {
  hir: HirGraph;
  symbolTable: SymbolTable;
  moduleId: string;
  modulePath: ModulePath;
  packageId: string;
  binding: BindingResult;
  typing: TypingResult;
}): ModuleExportTable => {
  const table: ModuleExportTable = new Map();

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
  ): { isPure: boolean; effectsText: string } => {
    try {
      const isPure = typing.effects.isEmpty(effectRow);
      return { isPure, effectsText: formatEffectRow(effectRow, typing.effects) };
    } catch {
      return { isPure: false, effectsText: "unknown effects" };
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

    const { isPure, effectsText } = getEffectInfo(signature.effectRow);

    if (!signature.annotatedEffects && !isPure && displayName !== "main") {
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
