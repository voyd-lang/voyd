import { Form } from "../../ast/form.js";
import {
  Expr,
  IdentifierAtom,
  isForm,
  isIdentifierAtom,
} from "../../ast/index.js";
import type { SyntaxMacro } from "../types.js";
import {
  ensureForm,
  cloneExpr,
  expectForm,
  expectIdentifier,
  recreateForm,
  cloneMacroEvalResult,
} from "./helpers.js";
import { renderFunctionalMacro, renderMacroVariable } from "./renderers.js";
import { MacroScope } from "./scope.js";
import { evalMacroExpr, expandMacroCall } from "./evaluator.js";
import type { MacroDefinition, MacroVariableBinding } from "./types.js";
import { nextMacroId } from "./macro-id.js";

export const functionalMacroExpander: SyntaxMacro = (form: Form): Form => {
  const scope = new MacroScope();
  return ensureForm(expandExpr(form, scope));
};

const expandExpr = (expr: Expr, scope: MacroScope): Expr => {
  if (!isForm(expr)) return expr;

  if (expr.calls("macro")) {
    return expandMacroDefinition(expr, scope);
  }

  if (expr.calls("macro_let")) {
    return expandMacroLet(expr, scope);
  }

  const head = expr.at(0);
  const macro = isIdentifierAtom(head) ? scope.getMacro(head.value) : undefined;
  if (macro) {
    const expanded = expandMacroCall(expr, macro, scope);
    return expandExpr(expanded, scope);
  }

  return expandForm(expr, scope);
};

const expandForm = (form: Form, scope: MacroScope): Form => {
  const head = form.at(0);
  const bodyScope = createsScopeFor(head) ? scope.child() : scope;
  const elements = form.toArray();
  const result: Expr[] = [];

  elements.forEach((child, index) => {
    if (isModuleName(head, index)) {
      result.push(child);
      return;
    }

    result.push(expandExpr(child, bodyScope));
  });

  return recreateForm(form, result);
};

const expandMacroDefinition = (form: Form, scope: MacroScope): Expr => {
  if (process.env.VITEST) {
    console.log(
      "expandMacroDefinition:",
      JSON.stringify(form.toJSON(), null, 2)
    );
  }
  const signature = expectForm(form.at(1), "macro signature");
  const name = expectIdentifier(signature.at(0), "macro name");
  const parameters = signature
    .toArray()
    .slice(1)
    .map((expr, index) =>
      expectIdentifier(
        expr,
        `macro parameter ${index + 1} for ${name.value ?? "anonymous macro"}`
      ).clone()
    );

  const bodyExpressions = form.toArray().slice(2).map(cloneExpr);

  const macro: MacroDefinition = {
    name: name.clone(),
    parameters,
    body: bodyExpressions,
    scope,
    id: new IdentifierAtom(`${name.value}#${nextMacroId()}`),
  };

  scope.defineMacro(macro);
  return renderFunctionalMacro(macro);
};

const expandMacroLet = (form: Form, scope: MacroScope): Expr => {
  const assignment = expectForm(form.at(1), "macro let assignment");
  const operator = assignment.at(0);
  if (!isIdentifierAtom(operator) || operator.value !== "=") {
    throw new Error("macro_let expects an assignment expression");
  }
  const identifier = expectIdentifier(assignment.at(1), "macro let identifier");
  const initializer = assignment.at(2);
  if (!initializer) {
    throw new Error("macro_let requires an initializer");
  }

  const value = evalMacroExpr(cloneExpr(initializer), scope);
  const binding: MacroVariableBinding = {
    name: identifier.clone(),
    value: cloneMacroEvalResult(value),
    mutable: false,
  };
  scope.defineVariable(binding);

  return renderMacroVariable(binding);
};

const createsScopeFor = (expr: Expr | undefined): boolean =>
  isIdentifierAtom(expr) &&
  (expr.value === "block" ||
    expr.value === "module" ||
    expr.value === "fn" ||
    expr.value === "ast");

const isModuleName = (head: Expr | undefined, index: number): boolean =>
  isIdentifierAtom(head) && head.value === "module" && index === 1;
