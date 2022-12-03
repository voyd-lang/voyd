import { importModule } from "../import-module.mjs";
import { ModuleInfo } from "../lib/module-info.mjs";
import { AST } from "../parser.mjs";

type Modules = Map<string, AST | "IN_PROGRESS">;
type Imports = [string, string][];

export const moduleSyntaxMacro = (ast: AST, info: ModuleInfo): AST =>
  resolveModule(ast, info);

const resolveModule = (ast: AST, info: ModuleInfo): AST => {
  const [imports, newAst] = resolveImports(ast);

  const module: AST = [
    "module",
    info.moduleId,
    ["imports", ...imports],
    ["exports"],
    newAst,
  ];

  if (!info.isRoot) return module;

  return [
    "root",
    ...expandImports(module[2] as Imports, info).values(),
    module,
  ];
};

const expandImports = (
  imports: Imports,
  info: ModuleInfo,
  modules: Modules = new Map()
): Modules => {
  for (const use of imports.slice(1)) {
    const moduleId = (use as [string, string])[0];
    if (modules.has(moduleId)) continue;
    modules.set(moduleId, "IN_PROGRESS");
    const module = importModule(moduleId, info.srcPath).module;
    expandImports(module[2] as Imports, info, modules);
    modules.set(moduleId, module);
  }
  return modules;
};

/** Resolves import statements (use) and removes them from the AST */
const resolveImports = (ast: AST, imports: Imports = []): [Imports, AST] => {
  const newAst = ast.reduce<AST>((newAst, expr) => {
    if (!(expr instanceof Array)) {
      newAst.push(expr);
      return newAst;
    }

    if (expr[0] === "use") {
      imports.push([expr[1] as string, expr[2] as string]);
      return newAst;
    }

    newAst.push(resolveImports(expr, imports)[1]);
    return newAst;
  }, []);
  return [imports, newAst];
};
