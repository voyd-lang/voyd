import type {
  BindingInputs,
  BindingContext,
  BindingResult,
} from "./types.js";
import { DeclTable } from "../decls.js";
import type { Syntax } from "../../parser/index.js";
import type { ModuleGraph, ModuleNode } from "../../modules/types.js";
import type { ModuleExportTable } from "../modules.js";
import { isPackageRootModule, packageIdFromPath } from "../packages.js";

export const createBindingContext = ({
  moduleForm,
  symbolTable,
  module,
  graph,
  moduleExports,
  dependencies,
}: BindingInputs): BindingContext => {
  const moduleNode =
    module ??
    ({
      id: moduleForm.location?.filePath ?? "<module>",
      path: { namespace: "src", segments: [] },
      origin: {
        kind: "file",
        filePath: moduleForm.location?.filePath ?? "<module>",
      },
      ast: moduleForm,
      source: "",
      dependencies: [],
    } as ModuleNode);
  const moduleGraph =
    graph ??
    ({
      entry: moduleNode.id,
      modules: new Map([[moduleNode.id, moduleNode]]),
      diagnostics: [],
    } as ModuleGraph);
  const exportTables = moduleExports ?? new Map<string, ModuleExportTable>();
  const dependencyBindings = dependencies ?? new Map<string, BindingResult>();

  const decls = new DeclTable();
  const packageId = packageIdFromPath(moduleNode.path);

  return {
    symbolTable,
    scopeByNode: new Map([[moduleForm.syntaxId, symbolTable.rootScope]]),
    decls,
    overloads: new Map(),
    overloadBySymbol: new Map(),
    diagnostics: [],
    overloadBuckets: new Map(),
    syntaxByNode: new Map([[moduleForm.syntaxId, moduleForm]]),
    nextModuleIndex: 0,
    module: moduleNode,
    graph: moduleGraph,
    modulePath: moduleNode.path,
    packageId,
    isPackageRoot: isPackageRootModule(moduleNode.path),
    moduleExports: exportTables,
    dependencies: dependencyBindings,
    uses: [],
    imports: [],
    staticMethods: new Map(),
    moduleMembers: new Map(),
    pendingStaticMethods: [],
    importedOverloadOptions: new Map(),
  };
};

export const toBindingResult = (ctx: BindingContext): BindingResult => ({
  symbolTable: ctx.symbolTable,
  scopeByNode: ctx.scopeByNode,
  decls: ctx.decls,
  functions: ctx.decls.functions,
  typeAliases: ctx.decls.typeAliases,
  objects: ctx.decls.objects,
  traits: ctx.decls.traits,
  impls: ctx.decls.impls,
  overloads: ctx.overloads,
  overloadBySymbol: ctx.overloadBySymbol,
  diagnostics: ctx.diagnostics,
  uses: ctx.uses,
  imports: ctx.imports,
  staticMethods: ctx.staticMethods,
  moduleMembers: ctx.moduleMembers,
  dependencies: ctx.dependencies,
  importedOverloadOptions: ctx.importedOverloadOptions,
  modulePath: ctx.modulePath,
  packageId: ctx.packageId,
  isPackageRoot: ctx.isPackageRoot,
});

export const rememberSyntax = (
  syntax: Syntax | undefined,
  ctx: Pick<BindingContext, "syntaxByNode">
): void => {
  if (!syntax) {
    return;
  }
  ctx.syntaxByNode.set(syntax.syntaxId, syntax);
};
