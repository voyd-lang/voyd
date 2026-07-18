import { Form, IdentifierAtom, isForm, type Syntax } from "../parser/index.js";
import { toSourceSpan } from "../parser/surface/utils.js";
import type { NormalizedUseEntry } from "../parser/surface/use-path.js";
import { resolveModuleRequest } from "./resolve.js";
import { modulePathToString } from "./path.js";
import type { ModuleGraph, ModuleNode } from "./types.js";
import { POST_SYNTAX_MACROS } from "../parser/syntax-macros/index.js";
import { expandFunctionalMacros } from "../parser/syntax-macros/functional-macro-expander/index.js";
import type { MacroDefinition } from "../parser/syntax-macros/functional-macro-expander/types.js";
import { MacroScope } from "../parser/syntax-macros/functional-macro-expander/scope.js";
import { cloneExpr } from "../parser/syntax-macros/functional-macro-expander/helpers.js";
import type { Diagnostic } from "../diagnostics/index.js";
import { diagnosticFromCode } from "../diagnostics/index.js";
import { SyntaxMacroError } from "../parser/syntax-macros/macro-error.js";
import {
  serializerAttributeMacro,
  stripSerializerAttributeForms,
} from "../parser/syntax-macros/serializer-attribute.js";
import {
  createSurfaceModuleView,
  type SurfaceModuleItem,
} from "../parser/surface/index.js";
import { requireModuleHeader } from "./views.js";

export const expandModuleMacros = (graph: ModuleGraph): Diagnostic[] =>
  createModuleMacroExpander().expand(graph).diagnostics;

export type ModuleMacroExpander = {
  invalidate(moduleId: string): void;
  reset(moduleId: string): void;
  expand(graph: ModuleGraph): {
    diagnostics: Diagnostic[];
    diagnosticsByModule: ReadonlyMap<string, Diagnostic[]>;
    expandedModuleIds: string[];
  };
};

export const createModuleMacroExpander = (): ModuleMacroExpander => {
  const exportsByModule = new Map<string, MacroExportTable>();
  const sourceAstByModule = new Map<string, Form>();
  const scopeUseEntriesByModule = new Map<
    string,
    Map<string, MacroScopeUseEntry>
  >();
  const documentationByLocationByModule = new Map<
    string,
    DocumentationByLocation
  >();
  const invalidatedModules = new Map<string, number>();
  const processedInvalidationByModule = new Map<string, number>();
  let nextInvalidationGeneration = 0;

  return {
    invalidate: (moduleId) => {
      nextInvalidationGeneration += 1;
      invalidatedModules.set(moduleId, nextInvalidationGeneration);
    },
    reset: (moduleId) => {
      invalidatedModules.delete(moduleId);
      processedInvalidationByModule.delete(moduleId);
      exportsByModule.delete(moduleId);
      sourceAstByModule.delete(moduleId);
      scopeUseEntriesByModule.delete(moduleId);
      documentationByLocationByModule.delete(moduleId);
    },
    expand: (graph) => {
      const diagnostics: Diagnostic[] = [];
      const diagnosticsByModule = new Map<string, Diagnostic[]>();
      const expandedModuleIds: string[] = [];

      sortModules(graph).forEach((id) => {
        const module = graph.modules.get(id);
        const invalidationGeneration = invalidatedModules.get(id);
        const isInvalidated = invalidationGeneration !== undefined;
        if (!module || (module.surface && !isInvalidated)) {
          return;
        }
        invalidatedModules.delete(id);
        if (isInvalidated) {
          processedInvalidationByModule.set(id, invalidationGeneration);
        }
        const moduleDiagnostics: Diagnostic[] = [];
        const sourceAst = sourceAstByModule.get(id);
        const documentationByLocation =
          documentationByLocationByModule.get(id) ??
          indexDocumentationByLocation(module);
        documentationByLocationByModule.set(id, documentationByLocation);
        if (sourceAst && isInvalidated) {
          module.ast = sourceAst.clone();
        } else if (!sourceAst) {
          sourceAstByModule.set(id, module.ast.clone());
        }

        // Imports exposed by expansion are discovery inputs on later passes.
        // Keep that discovery monotonic, while the surface below remains the
        // replaceable output of only the latest expansion.
        const headerItems = requireModuleHeader(module).items;
        const currentInlineModuleNames = collectInlineModuleNames(
          module.surface?.items ?? headerItems,
        );
        const scopeUseEntries = mergeScopeUseEntries({
          moduleId: id,
          entries: collectUseEntries(headerItems),
          inlineModuleNames: currentInlineModuleNames,
          scopeUseEntriesByModule,
        });
        const importedMacros = collectMacroImports({
          module,
          entries: scopeUseEntries,
          exportsByModule,
          sourceEntryKeys: new Set(
            collectUseEntries(headerItems).map(useEntryKey),
          ),
        });
        const scope = new MacroScope();
        importedMacros.macros.forEach((macro) => scope.defineMacro(macro));
        importedMacros.ambiguousNames.forEach((name) =>
          scope.defineAmbiguousMacro(name),
        );
        module.macroImports = Array.from(importedMacros.macros.entries()).map(
          ([name, macro]) => ({ name, kind: macro.kind }),
        );
        const attributeMacroReferences: NonNullable<
          ModuleNode["attributeMacroReferences"]
        >[number][] = [];
        const unknownAttributeSpans: ReturnType<typeof toSourceSpan>[] = [];
        const unknownAttributeKeys = new Set<string>();

        const functionalResult = expandFunctionalMacros(module.ast, {
          scope,
          moduleId: id,
          strictMacroSignatures: true,
          onAttributeExpansion: ({ invocationName, macro }) => {
            if (!macro.moduleId || !macro.declarationName.location) {
              return;
            }
            attributeMacroReferences.push({
              name: invocationName.value,
              macroId: macro.id.value,
              definitionName: macro.declarationName.value,
              definitionModuleId: macro.moduleId,
              invocationSpan: toSourceSpan(invocationName),
              definitionSpan: toSourceSpan(macro.declarationName),
            });
          },
          onUnknownAttribute: (invocationName) => {
            const span = toSourceSpan(invocationName);
            const key = `${invocationName.value}:${span.file}:${span.start}:${span.end}`;
            if (unknownAttributeKeys.has(key)) {
              return;
            }
            unknownAttributeKeys.add(key);
            unknownAttributeSpans.push(span);
            moduleDiagnostics.push(
              diagnosticFromCode({
                code: "MD0003",
                params: {
                  kind: "macro-expansion-failed",
                  macro: "attributeDispatcher",
                  errorMessage: `unknown attribute '@${invocationName.value}'`,
                },
                span,
              }),
            );
          },
          onError: (error) =>
            reportMacroExpansionError({
              diagnostics: moduleDiagnostics,
              macroName: "functionalMacroExpander",
              error,
              fallbackSyntax: module.ast,
            }),
        });
        module.attributeMacroReferences = attributeMacroReferences;
        module.ast = applyPostSyntaxMacros(
          functionalResult.form,
          moduleDiagnostics,
        );
        module.surface = createSurfaceModuleView(module.ast);
        remapExpandedDocumentation({ module, documentationByLocation });
        module.surface.issues.forEach((issue) => {
          const isUnknownAttributeIssue =
            issue.message ===
              "unsupported top-level form; expected a declaration" &&
            unknownAttributeSpans.some(
              (span) =>
                span.file === issue.span.file &&
                span.start >= issue.span.start &&
                span.start <= issue.span.end,
            );
          if (isUnknownAttributeIssue) {
            return;
          }
          moduleDiagnostics.push(
            diagnosticFromCode({
              code: "MD0002",
              params: {
                kind: "load-failed",
                requested: module.id,
                errorMessage: issue.message,
              },
              span: issue.span,
            }),
          );
        });
        const surfaceUseEntries = collectUseEntries(module.surface.items);
        const surfaceInlineModuleNames = collectInlineModuleNames(
          module.surface.items,
        );
        mergeScopeUseEntries({
          moduleId: id,
          entries: surfaceUseEntries,
          inlineModuleNames: surfaceInlineModuleNames,
          scopeUseEntriesByModule,
        });
        const localExports = indexExports(functionalResult.exports);
        const exportedMacros = collectMacroReexports({
          module,
          entries: surfaceUseEntries,
          inlineModuleNames: surfaceInlineModuleNames,
          exportsByModule,
          localExports,
        });
        const previousExports = exportsByModule.get(id);
        module.macroExports = Array.from(exportedMacros.macros.keys());
        exportsByModule.set(id, exportedMacros);
        const exportNamesChanged = !haveSameMacroExportNames(
          previousExports,
          exportedMacros,
        );
        const rebuiltExportDefinitions =
          isInvalidated &&
          (macroExportNameCount(previousExports) > 0 ||
            macroExportNameCount(exportedMacros) > 0);
        const propagationGeneration = rebuiltExportDefinitions
          ? invalidationGeneration
          : exportNamesChanged
            ? ++nextInvalidationGeneration
            : undefined;
        if (propagationGeneration !== undefined) {
          processedInvalidationByModule.set(id, propagationGeneration);
          invalidateMacroImporters({
            graph,
            exportedModuleId: id,
            invalidatedModules,
            processedInvalidationByModule,
            invalidationGeneration: propagationGeneration,
          });
        }
        diagnostics.push(...moduleDiagnostics);
        diagnosticsByModule.set(id, moduleDiagnostics);
        expandedModuleIds.push(id);
      });

      return { diagnostics, diagnosticsByModule, expandedModuleIds };
    },
  };
};

type MacroExportTable = {
  macros: Map<string, MacroDefinition>;
  ambiguousNames: Set<string>;
};
type UseEntryWithVisibility = NormalizedUseEntry & {
  visibility: "module" | "pub";
};
type MacroScopeUseEntry = {
  entry: UseEntryWithVisibility;
  inlineModuleNames: ReadonlySet<string>;
};
type DocumentationByLocation = {
  declarations: ReadonlyMap<string, string>;
  parameters: ReadonlyMap<string, string>;
};

const indexDocumentationByLocation = (
  module: ModuleNode,
): DocumentationByLocation => {
  const declarations = new Map<string, string>();
  const parameters = new Map<string, string>();
  const docs = module.docs;
  if (!docs) {
    return { declarations, parameters };
  }

  visitSyntax(module.ast, (syntax) => {
    const key = documentationLocationKey(syntax);
    if (!key) {
      return;
    }
    const declaration = docs.declarationsBySyntaxId.get(syntax.syntaxId);
    if (declaration !== undefined) {
      declarations.set(key, declaration);
    }
    const parameter = docs.parametersBySyntaxId.get(syntax.syntaxId);
    if (parameter !== undefined) {
      parameters.set(key, parameter);
    }
  });
  return { declarations, parameters };
};

const remapExpandedDocumentation = ({
  module,
  documentationByLocation,
}: {
  module: ModuleNode;
  documentationByLocation: DocumentationByLocation;
}): void => {
  const docs = module.docs;
  if (!docs) {
    return;
  }
  const declarations = new Map(docs.declarationsBySyntaxId);
  const parameters = new Map(docs.parametersBySyntaxId);
  visitSyntax(module.ast, (syntax) => {
    const key = documentationLocationKey(syntax);
    if (!key) {
      return;
    }
    const declaration = documentationByLocation.declarations.get(key);
    if (declaration !== undefined) {
      declarations.set(syntax.syntaxId, declaration);
    }
    const parameter = documentationByLocation.parameters.get(key);
    if (parameter !== undefined) {
      parameters.set(syntax.syntaxId, parameter);
    }
  });
  module.docs = {
    ...docs,
    declarationsBySyntaxId: declarations,
    parametersBySyntaxId: parameters,
  };
};

const visitSyntax = (
  syntax: Syntax,
  visit: (entry: Syntax) => void,
): void => {
  visit(syntax);
  if (isForm(syntax)) {
    syntax.toArray().forEach((entry) => visitSyntax(entry, visit));
  }
};

const documentationLocationKey = (syntax: Syntax): string | undefined => {
  const location = syntax.location;
  return location
    ? [
        syntax.syntaxType,
        location.filePath,
        location.startIndex,
        location.endIndex,
      ].join(":")
    : undefined;
};

const haveSameMacroExportNames = (
  previous: MacroExportTable | undefined,
  current: MacroExportTable,
): boolean =>
  macroExportNameCount(previous) === macroExportNameCount(current) &&
  Array.from(current.macros.keys()).every((name) =>
    previous?.macros.has(name),
  ) &&
  Array.from(current.ambiguousNames).every((name) =>
    previous?.ambiguousNames.has(name),
  );

const macroExportNameCount = (table: MacroExportTable | undefined): number =>
  (table?.macros.size ?? 0) + (table?.ambiguousNames.size ?? 0);

const invalidateMacroImporters = ({
  graph,
  exportedModuleId,
  invalidatedModules,
  processedInvalidationByModule,
  invalidationGeneration,
}: {
  graph: ModuleGraph;
  exportedModuleId: string;
  invalidatedModules: Map<string, number>;
  processedInvalidationByModule: Map<string, number>;
  invalidationGeneration: number;
}): void => {
  graph.modules.forEach((module) => {
    if (!module.surface) {
      return;
    }

    const importsChangedModule = module.dependencies.some(
      (dependency) =>
        dependency.kind === "use" &&
        modulePathToString(dependency.path) === exportedModuleId,
    );
    const alreadyProcessed =
      (processedInvalidationByModule.get(module.id) ?? -1) >=
      invalidationGeneration;
    if (!importsChangedModule || alreadyProcessed) {
      return;
    }

    const pendingGeneration = invalidatedModules.get(module.id) ?? -1;
    if (pendingGeneration < invalidationGeneration) {
      invalidatedModules.set(module.id, invalidationGeneration);
    }
  });
};

const applyPostSyntaxMacros = (form: Form, diagnostics: Diagnostic[]): Form => {
  let current = form;

  POST_SYNTAX_MACROS.forEach((macro) => {
    try {
      current = macro(current);
    } catch (error) {
      reportMacroExpansionError({
        diagnostics,
        macroName: macro.name || "<syntax-macro>",
        error,
        fallbackSyntax: current,
      });

      if (macro === serializerAttributeMacro) {
        current = stripSerializerAttributeForms(current);
      }
    }
  });

  return current;
};

const reportMacroExpansionError = ({
  diagnostics,
  macroName,
  error,
  fallbackSyntax,
}: {
  diagnostics: Diagnostic[];
  macroName: string;
  error: unknown;
  fallbackSyntax: Form;
}): void => {
  const message = error instanceof Error ? error.message : String(error);
  const syntax =
    error instanceof SyntaxMacroError
      ? (error.syntax ?? fallbackSyntax)
      : fallbackSyntax;

  diagnostics.push(
    diagnosticFromCode({
      code: "MD0003",
      params: {
        kind: "macro-expansion-failed",
        macro: macroName,
        errorMessage: message,
      },
      span: toSourceSpan(syntax),
    }),
  );
};

const indexExports = (exports: MacroDefinition[]): MacroExportTable => {
  const table = new Map<string, MacroDefinition>();
  exports.forEach((macro) => {
    table.set(macro.name.value, macro);
  });
  return { macros: table, ambiguousNames: new Set() };
};

const collectInlineModuleNames = (
  items: readonly SurfaceModuleItem[],
): Set<string> => {
  return new Set(
    items.flatMap((item) =>
      item.kind === "inline-module" ? [item.declaration.name] : [],
    ),
  );
};

const collectMacroImports = ({
  module,
  entries,
  exportsByModule,
  sourceEntryKeys,
}: {
  module: ModuleNode;
  entries: MacroScopeUseEntry[];
  exportsByModule: Map<string, MacroExportTable>;
  sourceEntryKeys: ReadonlySet<string>;
}): {
  macros: Map<string, MacroDefinition>;
  ambiguousNames: Set<string>;
} => {
  const imports = new Map<string, MacroDefinition>();
  const importedFromSource = new Map<string, boolean>();
  const ambiguousNames = new Set<string>();
  const addImport = ({
    name,
    macro,
    fromSource,
  }: {
    name: string;
    macro: MacroDefinition;
    fromSource: boolean;
  }): void => {
    if (ambiguousNames.has(name)) {
      return;
    }
    const existing = imports.get(name);
    const hasAttributeMacro =
      existing?.kind === "attribute" || macro.kind === "attribute";
    if (
      existing &&
      existing.id.value !== macro.id.value &&
      (hasAttributeMacro ||
        (importedFromSource.get(name) === true && fromSource))
    ) {
      imports.delete(name);
      ambiguousNames.add(name);
      return;
    }
    ambiguousNames.delete(name);
    imports.set(name, macro);
    importedFromSource.set(name, fromSource);
  };
  const moduleIsPackageRoot =
    module.origin.kind === "file" && module.path.segments.at(-1) === "pkg";
  entries.forEach(({ entry, inlineModuleNames }) => {
    const fromSource = sourceEntryKeys.has(useEntryKey(entry));
    if (!entry.hasExplicitPrefix) {
      return;
    }
    if (entry.selectionKind === "module") {
      return;
    }
    const firstSegment = entry.moduleSegments[0];
    const preservesInlinePkgScope =
      moduleIsPackageRoot &&
      entry.anchorToSelf === true &&
      (entry.parentHops ?? 0) === 0 &&
      typeof firstSegment === "string" &&
      inlineModuleNames.has(firstSegment);

    const resolvedPath = resolveModuleRequest(
      { segments: entry.moduleSegments, span: entry.span },
      module.path,
      {
        anchorToSelf: entry.anchorToSelf,
        parentHops: entry.parentHops ?? 0,
        importerIsPackageRoot: moduleIsPackageRoot && !preservesInlinePkgScope,
      },
    );
    const moduleId = modulePathToString(resolvedPath);
    const exportedMacros = exportsByModule.get(moduleId);
    if (!exportedMacros) {
      return;
    }

    if (entry.selectionKind === "all") {
      exportedMacros.macros.forEach((macro, name) => {
        addImport({ name, macro, fromSource });
      });
      exportedMacros.ambiguousNames.forEach((name) => {
        imports.delete(name);
        ambiguousNames.add(name);
      });
      return;
    }

    const targetName = entry.targetName;
    if (!targetName) {
      return;
    }

    const alias = entry.alias ?? targetName;
    if (exportedMacros.ambiguousNames.has(targetName)) {
      imports.delete(alias);
      ambiguousNames.add(alias);
      return;
    }

    const macro = exportedMacros.macros.get(targetName);
    if (!macro) {
      return;
    }

    const definition =
      alias === macro.name.value ? macro : cloneMacroWithAlias(macro, alias);
    addImport({ name: alias, macro: definition, fromSource });
  });

  return { macros: imports, ambiguousNames };
};

const collectMacroReexports = ({
  module,
  entries,
  inlineModuleNames,
  exportsByModule,
  localExports,
}: {
  module: ModuleNode;
  entries: UseEntryWithVisibility[];
  inlineModuleNames: ReadonlySet<string>;
  exportsByModule: Map<string, MacroExportTable>;
  localExports: MacroExportTable;
}): MacroExportTable => {
  const exports = new Map(localExports.macros);
  const ambiguousNames = new Set(localExports.ambiguousNames);
  const addReexport = (name: string, macro: MacroDefinition): void => {
    if (localExports.macros.has(name) || ambiguousNames.has(name)) {
      return;
    }
    const existing = exports.get(name);
    if (
      existing &&
      existing.id.value !== macro.id.value &&
      (existing.kind === "attribute" || macro.kind === "attribute")
    ) {
      exports.delete(name);
      ambiguousNames.add(name);
      return;
    }
    if (!existing) {
      exports.set(name, macro);
    }
  };
  const addAmbiguousReexport = (name: string): void => {
    if (localExports.macros.has(name)) {
      return;
    }
    exports.delete(name);
    ambiguousNames.add(name);
  };
  const moduleIsPackageRoot =
    module.origin.kind === "file" && module.path.segments.at(-1) === "pkg";
  entries
    .filter((entry) => entry.visibility === "pub")
    .forEach((entry) => {
      if (!entry.hasExplicitPrefix) {
        return;
      }
      if (entry.selectionKind === "module") {
        return;
      }
      const firstSegment = entry.moduleSegments[0];
      const preservesInlinePkgScope =
        moduleIsPackageRoot &&
        entry.anchorToSelf === true &&
        (entry.parentHops ?? 0) === 0 &&
        typeof firstSegment === "string" &&
        inlineModuleNames.has(firstSegment);

      const resolvedPath = resolveModuleRequest(
        { segments: entry.moduleSegments, span: entry.span },
        module.path,
        {
          anchorToSelf: entry.anchorToSelf,
          parentHops: entry.parentHops ?? 0,
          importerIsPackageRoot:
            moduleIsPackageRoot && !preservesInlinePkgScope,
        },
      );
      const moduleId = modulePathToString(resolvedPath);
      const exportedMacros = exportsByModule.get(moduleId);
      if (!exportedMacros) {
        return;
      }

      if (entry.selectionKind === "all") {
        exportedMacros.macros.forEach((macro, name) =>
          addReexport(name, macro),
        );
        exportedMacros.ambiguousNames.forEach(addAmbiguousReexport);
        return;
      }

      const targetName = entry.targetName;
      if (!targetName) {
        return;
      }

      const alias = entry.alias ?? targetName;
      if (exportedMacros.ambiguousNames.has(targetName)) {
        addAmbiguousReexport(alias);
        return;
      }

      const macro = exportedMacros.macros.get(targetName);
      if (!macro) {
        return;
      }

      addReexport(
        alias,
        alias === macro.name.value
          ? macro
          : cloneMacroWithAlias(macro, alias),
      );
    });

  return { macros: exports, ambiguousNames };
};

const collectUseEntries = (
  items: readonly SurfaceModuleItem[],
): UseEntryWithVisibility[] => {
  return items.flatMap((item) =>
    item.kind === "use"
      ? item.entries.map((entry) => ({
          ...entry,
          visibility: item.visibility,
        }))
      : [],
  );
};

const mergeScopeUseEntries = ({
  moduleId,
  entries,
  inlineModuleNames,
  scopeUseEntriesByModule,
}: {
  moduleId: string;
  entries: readonly UseEntryWithVisibility[];
  inlineModuleNames: ReadonlySet<string>;
  scopeUseEntriesByModule: Map<string, Map<string, MacroScopeUseEntry>>;
}): MacroScopeUseEntry[] => {
  const scopeEntries =
    scopeUseEntriesByModule.get(moduleId) ??
    new Map<string, MacroScopeUseEntry>();
  entries.forEach((entry) =>
    scopeEntries.set(useEntryKey(entry), { entry, inlineModuleNames }),
  );
  scopeUseEntriesByModule.set(moduleId, scopeEntries);
  return Array.from(scopeEntries.values());
};

const useEntryKey = (entry: UseEntryWithVisibility): string =>
  JSON.stringify([
    entry.visibility,
    entry.moduleSegments,
    entry.path,
    entry.targetName ?? null,
    entry.alias ?? null,
    entry.selectionKind,
    entry.anchorToSelf ?? false,
    entry.parentHops ?? 0,
    entry.hasExplicitPrefix,
  ]);

const cloneMacroWithAlias = (
  macro: MacroDefinition,
  alias: string,
): MacroDefinition => ({
  kind: macro.kind,
  name: new IdentifierAtom(alias),
  declarationName: macro.declarationName.clone(),
  parameters: macro.parameters.map((param) => param.clone()),
  body: macro.body.map((expr) => cloneExpr(expr)),
  scope: macro.scope,
  id: macro.id.clone(),
  moduleId: macro.moduleId,
});

const sortModules = (graph: ModuleGraph): string[] => {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const order: string[] = [];

  const visit = (id: string) => {
    if (visited.has(id) || visiting.has(id)) {
      return;
    }

    visiting.add(id);
    const node = graph.modules.get(id);
    node?.dependencies.forEach((dep) => {
      const depId = modulePathToString(dep.path);
      if (graph.modules.has(depId)) {
        visit(depId);
      }
    });
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  };

  graph.modules.forEach((_, id) => visit(id));
  return order;
};
