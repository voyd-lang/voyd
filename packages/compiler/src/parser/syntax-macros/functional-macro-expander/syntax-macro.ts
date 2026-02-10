import { Form } from "../../ast/form.js";
import {
  Expr,
  IdentifierAtom,
  isForm,
  isIdentifierAtom,
} from "../../ast/index.js";
import type { SyntaxMacro } from "../types.js";
import { SyntaxMacroError } from "../macro-error.js";
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

type MacroDefinitionInput = {
  signature: Form;
  bodyExpressions: Expr[];
  visibility: "pub" | "module";
};

export const functionalMacroExpander: SyntaxMacro = (form: Form): Form =>
  expandFunctionalMacros(form).form;

export const expandFunctionalMacros = (
  form: Form,
  options: { scope?: MacroScope } = {}
): { form: Form; exports: MacroDefinition[] } => {
  const scope = options.scope ?? new MacroScope();
  const exports: MacroDefinition[] = [];
  return { form: ensureForm(expandExpr(form, scope, exports)), exports };
};

const expandExpr = (
  expr: Expr,
  scope: MacroScope,
  exports: MacroDefinition[]
): Expr => {
  if (!isForm(expr)) {
    return expr;
  }

  try {
    const macroDefinition = parseMacroDefinition(expr);
    if (macroDefinition) {
      return expandMacroDefinition(macroDefinition, scope, exports);
    }

    if (expr.calls("macro_let")) {
      return expandMacroLet(expr, scope);
    }

    const head = expr.at(0);
    const macro = isIdentifierAtom(head) ? scope.getMacro(head.value) : undefined;
    if (macro) {
      const expanded = expandMacroCall(expr, macro, scope);
      return expandExpr(expanded, scope, exports);
    }

    return expandForm(expr, scope, exports);
  } catch (error) {
    throw toSyntaxMacroError(error, expr);
  }
};

const expandForm = (
  form: Form,
  scope: MacroScope,
  exports: MacroDefinition[]
): Form => {
  const head = form.at(0);
  const bodyScope = createsScopeFor(head) ? scope.child() : scope;
  const elements = form.toArray();
  const result: Expr[] = [];

  elements.forEach((child, index) => {
    if (isModuleName(head, index)) {
      result.push(child);
      return;
    }

    result.push(expandExpr(child, bodyScope, exports));
  });

  return recreateForm(form, result);
};

const expandMacroDefinition = (
  definition: MacroDefinitionInput,
  scope: MacroScope,
  exports: MacroDefinition[]
): Expr => {
  const signature = definition.signature;
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

  const macro: MacroDefinition = {
    name: name.clone(),
    parameters,
    body: definition.bodyExpressions,
    scope,
    id: new IdentifierAtom(`${name.value}#${nextMacroId()}`),
  };

  scope.defineMacro(macro);
  if (definition.visibility === "pub") {
    exports.push(macro);
  }
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

const parseMacroDefinition = (form: Form): MacroDefinitionInput | null => {
  let index = 0;
  let visibility: MacroDefinitionInput["visibility"] = "module";
  const first = form.at(0);

  if (isIdentifierAtom(first) && first.value === "pub") {
    visibility = "pub";
    index = 1;
  }

  const keyword = form.at(index);
  if (!isIdentifierAtom(keyword) || keyword.value !== "macro") {
    return null;
  }

  const signatureExpr = form.at(index + 1);
  if (!signatureExpr || !isForm(signatureExpr)) {
    return null;
  }

  const signature = signatureExpr;
  const bodyExpressions = form
    .toArray()
    .slice(index + 2)
    .map(cloneExpr);

  return { signature, bodyExpressions, visibility };
};

const toSyntaxMacroError = (error: unknown, syntax: Expr): SyntaxMacroError => {
  if (error instanceof SyntaxMacroError) {
    return error.syntax ? error : new SyntaxMacroError(error.message, syntax);
  }

  const message = error instanceof Error ? error.message : String(error);
  return new SyntaxMacroError(message, syntax);
};
