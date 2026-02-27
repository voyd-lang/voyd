import { Form, IdentifierAtom, isForm } from "../parser/index.js";
import { toSourceSpan } from "../semantics/utils.js";
import { classifyTopLevelDecl } from "./use-decl.js";
import { parseUsePaths, type NormalizedUseEntry } from "./use-path.js";
import { resolveModuleRequest } from "./resolve.js";
import { modulePathToString } from "./path.js";
import type { ModuleGraph, ModuleNode } from "./types.js";
import { POST_SYNTAX_MACROS } from "../parser/syntax-macros/index.js";
import {
  expandFunctionalMacros,
} from "../parser/syntax-macros/functional-macro-expander/index.js";
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

export const expandModuleMacros = (graph: ModuleGraph): Diagnostic[] => {
  const order = sortModules(graph);
  const exportsByModule = new Map<string, MacroExportTable>();
  const diagnostics: Diagnostic[] = [];

  order.forEach((id) => {
    const module = graph.modules.get(id);
    if (!module) {
      return;
    }

    const useEntries = collectUseEntries(module.ast);
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
          diagnostics,
          macroName: "functionalMacroExpander",
          error,
          fallbackSyntax: module.ast,
        }),
    });
    module.ast = applyPostSyntaxMacros(functionalResult.form, diagnostics);
    const { exports } = functionalResult;
    const localExports = indexExports(exports);
    const exportedMacros = collectMacroReexports({
      module,
      entries: useEntries,
      exportsByModule,
      localExports,
    });
    module.macroExports = Array.from(exportedMacros.keys());
    exportsByModule.set(id, exportedMacros);
  });

  return diagnostics;
};

type MacroExportTable = Map<string, MacroDefinition>;
type UseEntryWithVisibility = NormalizedUseEntry & {
  visibility: "module" | "pub";
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
    error instanceof SyntaxMacroError ? error.syntax ?? fallbackSyntax : fallbackSyntax;

  diagnostics.push(
    diagnosticFromCode({
      code: "MD0003",
      params: {
        kind: "macro-expansion-failed",
        macro: macroName,
        errorMessage: message,
      },
      span: toSourceSpan(syntax),
    })
  );
};

const indexExports = (exports: MacroDefinition[]): MacroExportTable => {
  const table = new Map<string, MacroDefinition>();
  exports.forEach((macro) => {
    table.set(macro.name.value, macro);
  });
  return table;
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
  entries.forEach((entry) => {
    if (!entry.hasExplicitPrefix) {
      return;
    }
    if (entry.selectionKind === "module") {
      return;
    }

    const resolvedPath = resolveModuleRequest(
      { segments: entry.moduleSegments, span: entry.span },
      module.path,
      {
        anchorToSelf: entry.anchorToSelf,
        parentHops: entry.parentHops ?? 0,
        importerIsPackageRoot: moduleIsPackageRoot,
      }
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

  entries
    .filter((entry) => entry.visibility === "pub")
    .forEach((entry) => {
      if (!entry.hasExplicitPrefix) {
        return;
      }
      if (entry.selectionKind === "module") {
        return;
      }

      const resolvedPath = resolveModuleRequest(
        { segments: entry.moduleSegments, span: entry.span },
        module.path,
        {
          anchorToSelf: entry.anchorToSelf,
          parentHops: entry.parentHops ?? 0,
          importerIsPackageRoot: moduleIsPackageRoot,
        }
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
          alias === macro.name.value ? macro : cloneMacroWithAlias(macro, alias)
        );
      }
    });

  return exports;
};

const collectUseEntries = (form: Form): UseEntryWithVisibility[] => {
  const entries: UseEntryWithVisibility[] = [];
  const body = form.callsInternal("ast") ? form.rest : form.toArray();

  body.forEach((entry) => {
    if (!isForm(entry)) {
      return;
    }

    const useDecl = parseUseDecl(entry);
    if (!useDecl) {
      return;
    }

    useDecl.entries.forEach((useEntry) => {
      entries.push({ ...useEntry, visibility: useDecl.visibility });
    });
  });

  return entries;
};

const parseUseDecl = (
  form: Form
): { entries: NormalizedUseEntry[]; visibility: "module" | "pub" } | null => {
  const classified = classifyTopLevelDecl(form);
  if (classified.kind !== "use-decl") {
    return null;
  }
  return {
    entries: parseUsePaths(classified.pathExpr, toSourceSpan(form)),
    visibility: classified.visibility,
  };
};

const cloneMacroWithAlias = (
  macro: MacroDefinition,
  alias: string
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
