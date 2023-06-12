import { ModuleInfo } from "../lib/module-info.mjs";
import {
  Expr,
  Identifier,
  isIdentifier,
  isList,
  List,
} from "../lib/syntax/index.mjs";
import { Macro, RegularMacro } from "../lib/syntax/macros.mjs";
import { evalMacroVarDef, expandMacro } from "./lib/expand-macro.mjs";

/** Transforms macro's into their final form and then runs them */
export const macro = (list: List, info: ModuleInfo): List => {
  if (!info.isRoot) return list;
  return evalExpr(list) as List;
};

const evalExpr = (expr: Expr): Expr => {
  if (!isList(expr)) return expr;
  if (expr.calls("pub")) return evalPubList(expr);
  if (expr.calls("macro")) return evalMacroDef(expr);
  if (expr.calls("macro-let")) return evalMacroLetDef(expr);

  const identifier = expr.first();
  if (!isIdentifier(identifier)) {
    return expr.map(evalExpr);
  }

  const macro = identifier.resolveAsMacroEntity();
  if (macro?.syntaxType === "macro") {
    return evalExpr(expandMacro(macro, expr));
  }

  return expr.map(evalExpr);
};

const evalPubList = (list: List) => {
  const value = evalExpr(list.slice(1));
  if (value.syntaxType === "macro") {
    list.getParent()?.registerEntity(value.identifier, value);
  }

  if (value.syntaxType === "macro-variable") {
    list.getParent()?.registerEntity(value.identifier, value);
  }

  return new List({ value: ["export", value] });
};

const evalMacroDef = (list: List) => {
  const macro = listToMacro(list);
  list.getParent()?.registerEntity(macro.identifier, macro);
  return macro;
};

const evalMacroLetDef = (list: List) =>
  evalMacroVarDef(list.slice(1).insert("define"));

/** Slice out the beginning macro before calling */
const listToMacro = (list: List): Macro => {
  // TODO Assertions?
  const signature = list.first() as List;
  const identifier = signature.first() as Identifier;
  const parameters = signature.rest() as Identifier[];
  const body = list.slice(1).map(evalExpr);
  const macro = new RegularMacro({
    inherit: list,
    identifier,
    parameters,
    body,
  });
  return macro;
};
