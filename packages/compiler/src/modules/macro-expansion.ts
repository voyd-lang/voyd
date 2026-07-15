import { Form, IdentifierAtom } from "../parser/index.js";
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
import { createSurfaceModuleView } from "../parser/surface/index.js";
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
        if (sourceAst && isInvalidated) {
          module.ast = sourceAst.clone();
        } else if (!sourceAst) {
          sourceAstByModule.set(id, module.ast.clone());
        }

        const useEntries = collectUseEntries(module);
        const importedMacros = collectMacroImports({
          module,
          entries: useEntries,
          exportsByModule,
        });
        const scope = new MacroScope();
        importedMacros.forEach((macro) => scope.defineMacro(macro));

        const functionalResult = expandFunctionalMacros(module.ast, {
          scope,
          strictMacroSignatures: true,
          onError: (error) =>
            reportMacroExpansionError({
              diagnostics: moduleDiagnostics,
              macroName: "functionalMacroExpander",
              error,
              fallbackSyntax: module.ast,
            }),
        });
        module.ast = applyPostSyntaxMacros(
          functionalResult.form,
          moduleDiagnostics,
        );
        module.surface = createSurfaceModuleView(module.ast);
        module.surface.issues.forEach((issue) => {
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
        const localExports = indexExports(functionalResult.exports);
        const exportedMacros = collectMacroReexports({
          module,
          entries: useEntries,
          exportsByModule,
          localExports,
        });
        const previousExports = exportsByModule.get(id);
        module.macroExports = Array.from(exportedMacros.keys());
        exportsByModule.set(id, exportedMacros);
        const exportNamesChanged = !haveSameMacroExportNames(
          previousExports,
          exportedMacros,
        );
        const rebuiltExportDefinitions =
          isInvalidated &&
          ((previousExports?.size ?? 0) > 0 || exportedMacros.size > 0);
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

type MacroExportTable = Map<string, MacroDefinition>;
type UseEntryWithVisibility = NormalizedUseEntry & {
  visibility: "module" | "pub";
};

const haveSameMacroExportNames = (
  previous: MacroExportTable | undefined,
  current: MacroExportTable,
): boolean =>
  (previous?.size ?? 0) === current.size &&
  Array.from(current.keys()).every((name) => previous?.has(name));

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
  return table;
};

const inlineModuleNamesFor = (module: ModuleNode): Set<string> => {
  const items = module.surface?.items ?? requireModuleHeader(module).items;
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
}: {
  module: ModuleNode;
  entries: UseEntryWithVisibility[];
  exportsByModule: Map<string, MacroExportTable>;
}): Map<string, MacroDefinition> => {
  const imports = new Map<string, MacroDefinition>();
  const moduleIsPackageRoot =
    module.origin.kind === "file" && module.path.segments.at(-1) === "pkg";
  const inlineModuleNames = inlineModuleNamesFor(module);
  entries.forEach((entry) => {
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
      exportedMacros.forEach((macro, name) => {
        imports.set(name, macro);
      });
      return;
    }

    const targetName = entry.targetName;
    if (!targetName) {
      return;
    }

    const macro = exportedMacros.get(targetName);
    if (!macro) {
      return;
    }

    const alias = entry.alias ?? targetName;
    const definition =
      alias === macro.name.value ? macro : cloneMacroWithAlias(macro, alias);
    imports.set(alias, definition);
  });

  return imports;
};

const collectMacroReexports = ({
  module,
  entries,
  exportsByModule,
  localExports,
}: {
  module: ModuleNode;
  entries: UseEntryWithVisibility[];
  exportsByModule: Map<string, MacroExportTable>;
  localExports: MacroExportTable;
}): MacroExportTable => {
  const exports = new Map(localExports);
  const moduleIsPackageRoot =
    module.origin.kind === "file" && module.path.segments.at(-1) === "pkg";
  const inlineModuleNames = inlineModuleNamesFor(module);

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
        exportedMacros.forEach((macro, name) => {
          if (!exports.has(name)) {
            exports.set(name, macro);
          }
        });
        return;
      }

      const targetName = entry.targetName;
      if (!targetName) {
        return;
      }

      const macro = exportedMacros.get(targetName);
      if (!macro) {
        return;
      }

      const alias = entry.alias ?? targetName;
      if (!exports.has(alias)) {
        exports.set(
          alias,
          alias === macro.name.value
            ? macro
            : cloneMacroWithAlias(macro, alias),
        );
      }
    });

  return exports;
};

const collectUseEntries = (module: ModuleNode): UseEntryWithVisibility[] => {
  const items = module.surface?.items ?? requireModuleHeader(module).items;
  return items.flatMap((item) =>
    item.kind === "use"
      ? item.entries.map((entry) => ({
          ...entry,
          visibility: item.visibility,
        }))
      : [],
  );
};

const cloneMacroWithAlias = (
  macro: MacroDefinition,
  alias: string,
): MacroDefinition => ({
  name: new IdentifierAtom(alias),
  parameters: macro.parameters.map((param) => param.clone()),
  body: macro.body.map((expr) => cloneExpr(expr)),
  scope: macro.scope,
  id: macro.id.clone(),
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
