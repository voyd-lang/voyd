import { importModule } from "../import-module.mjs";
import {
  ModuleImports,
  ModuleInfo,
  resolveModule as resolveModuleInfo,
} from "../lib/module-info.mjs";
import { AST } from "../parser.mjs";

type Modules = Map<string, AST | "IN_PROGRESS">;

export const moduleSyntaxMacro = (ast: AST, info: ModuleInfo): AST =>
  resolveModule(ast, info);

const resolveModule = (ast: AST, info: ModuleInfo): AST => {
  const newAst = resolveImports(ast, info);

  const module: AST = [
    "module",
    info.moduleId,
    ["imports", ...info.imports.map(([info, expr]) => [info.moduleId, expr])],
    ["exports"],
    newAst,
  ];

  if (!info.isRoot) return module;

  return ["root", ...expandImports(info.imports).values(), module];
};

const expandImports = (
  imports: ModuleImports,
  modules: Modules = new Map()
): Modules => {
  for (const [importInfo] of imports) {
    if (modules.has(importInfo.moduleId)) continue;
    modules.set(importInfo.moduleId, "IN_PROGRESS");
    const module = importModule(importInfo);
    expandImports(module.imports, modules);
    // Must come after expansion of its own imports (for now)
    modules.delete(module.moduleId);
    modules.set(module.moduleId, module.ast);
  }
  return modules;
};

const stdModuleInfo = resolveModuleInfo({
  srcPath: "",
  usePath: "std/index",
  workingDir: "",
});

// TODO: Support import scoping
/** Resolves import statements (use) and removes them from the AST */
const resolveImports = (ast: AST, info: ModuleInfo): AST => {
  if (!info.moduleId.startsWith("std") && !info.imports.length) {
    info.imports.push([stdModuleInfo, "***"]);
  }

  const newAst = ast.reduce<AST>((newAst, expr) => {
    if (!(expr instanceof Array)) {
      newAst.push(expr);
      return newAst;
    }

    if (expr[0] === "use") {
      info.imports.push([
        resolveModuleInfo({
          usePath: expr[1] as string,
          srcPath: info.srcPath,
          workingDir: info.workingDir,
          isRoot: info.isRoot,
        }),
        expr[2] as string,
      ]);
      return newAst;
    }

    newAst.push(resolveImports(expr, info));
    return newAst;
  }, []);

  return newAst;
};
