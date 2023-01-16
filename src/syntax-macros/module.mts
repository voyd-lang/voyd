import { importModule } from "../import-module.mjs";
import {
  ModuleImports,
  ModuleInfo,
  resolveModule as resolveModuleInfo,
} from "../lib/module-info.mjs";
import { isList, List, noop } from "../lib/syntax/index.mjs";

type Modules = Map<string, List | "IN_PROGRESS">;

export const moduleSyntaxMacro = (list: List, info: ModuleInfo): List =>
  resolveModule(list, info);

const resolveModule = (list: List, info: ModuleInfo): List => {
  const newAst = resolveImports(list, info);

  const module = new List({
    value: [
      "module",
      info.moduleId,
      [
        "imports",
        ...info.imports.map(([info, expr, r]) => {
          const val = [info.moduleId, expr];
          if (r) val.push(r);
          return val;
        }),
      ],
      ["exports"],
      newAst,
    ],
  });

  if (!info.isRoot) return module;

  return new List({
    value: ["root", ...expandImports(info.imports).values(), module],
  });
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
const resolveImports = (list: List, info: ModuleInfo): List => {
  if (!info.moduleId.startsWith("std") && !info.imports.length) {
    info.imports.push([stdModuleInfo, "***"]);
  }

  return list.reduce((expr) => {
    if (!isList(expr)) return expr;

    const { isUseExpr, isReExported } = getUseInfo(expr);
    const pathIndex = isReExported ? 2 : 1;
    if (isUseExpr) {
      info.imports.push([
        resolveModuleInfo({
          usePath: expr.at(pathIndex)!.value as string,
          srcPath: info.srcPath,
          workingDir: info.workingDir,
          isRoot: info.isRoot,
        }),
        expr.at(2)!.value as string,
        isReExported ? "re-exported" : undefined,
      ]);
      return noop();
    }

    return resolveImports(expr, info);
  });
};

const getUseInfo = (
  expr: List
): { isUseExpr: boolean; isReExported?: boolean } => {
  if (expr.calls("use")) return { isUseExpr: true };
  if (expr.calls("pub") && expr.at(1)?.is("use")) {
    return { isUseExpr: true, isReExported: true };
  }
  return { isUseExpr: false };
};
