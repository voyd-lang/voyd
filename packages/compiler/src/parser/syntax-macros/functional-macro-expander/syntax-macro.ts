import { Form } from "../../ast/form.js";
import {
  Expr,
  IdentifierAtom,
  isForm,
  isIdentifierAtom,
  isInternalIdentifierAtom,
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

type ExpandFunctionalMacroOptions = {
  scope?: MacroScope;
  strictMacroSignatures?: boolean;
  onError?: (error: SyntaxMacroError) => void;
};

export const functionalMacroExpander: SyntaxMacro = (form: Form): Form =>
  expandFunctionalMacros(form).form;

export const expandFunctionalMacros = (
  form: Form,
  options: ExpandFunctionalMacroOptions = {}
): { form: Form; exports: MacroDefinition[] } => {
  const scope = options.scope ?? new MacroScope();
  const exports: MacroDefinition[] = [];
  try {
    return { form: ensureForm(expandExpr(form, scope, exports, options)), exports };
  } catch (error) {
    const macroError = toSyntaxMacroError(error, form);
    if (!options.onError) {
      throw macroError;
    }
    options.onError(macroError);
    return { form, exports };
  }
};

const expandExpr = (
  expr: Expr,
  scope: MacroScope,
  exports: MacroDefinition[],
  options: ExpandFunctionalMacroOptions
): Expr => {
  if (!isForm(expr)) {
    return expr;
  }

  try {
    const macroDefinition = parseMacroDefinition({
      form: expr,
      strictMacroSignatures: options.strictMacroSignatures === true,
    });
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
      return expandExpr(expanded, scope, exports, options);
    }

    const visibilityWrapped = expandVisibilityWrappedMacroCall({
      expr,
      scope,
      exports,
      options,
    });
    if (visibilityWrapped) {
      return visibilityWrapped;
    }

    return expandForm(expr, scope, exports, options);
  } catch (error) {
    throw toSyntaxMacroError(error, expr);
  }
};

const expandForm = (
  form: Form,
  scope: MacroScope,
  exports: MacroDefinition[],
  options: ExpandFunctionalMacroOptions
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

    const expanded = expandExpr(child, bodyScope, exports, options);
    if (
      isTopLevelAst(form) &&
      isForm(expanded) &&
      isBlockLikeForm(expanded)
    ) {
      result.push(...expanded.rest);
      return;
    }
    result.push(expanded);
  });

  return recreateForm(form, result);
};

const expandVisibilityWrappedMacroCall = ({
  expr,
  scope,
  exports,
  options,
}: {
  expr: Form;
  scope: MacroScope;
  exports: MacroDefinition[];
  options: ExpandFunctionalMacroOptions;
}): Expr | undefined => {
  const visibility = expr.at(0);
  const macroName = expr.at(1);
  if (!isIdentifierAtom(visibility) || visibility.value !== "pub") {
    return undefined;
  }
  if (!isIdentifierAtom(macroName)) {
    return undefined;
  }

  const macro = scope.getMacro(macroName.value);
  if (!macro) {
    return undefined;
  }

  const invocation = recreateForm(expr, [macroName, ...expr.toArray().slice(2)]);
  const expanded = expandMacroCall(invocation, macro, scope);
  const withVisibility = applyPubVisibility(expanded);
  return expandExpr(withVisibility, scope, exports, options);
};

const applyPubVisibility = (expr: Expr): Expr => {
  if (!isForm(expr)) {
    return expr;
  }

  if (expr.calls("block")) {
    return recreateForm(expr, [
      expr.first!,
      ...expr.rest.map((entry) => withPubModifier(entry)),
    ]);
  }

  return withPubModifier(expr);
};

const withPubModifier = (expr: Expr): Expr => {
  if (!isForm(expr)) {
    return expr;
  }

  const first = expr.at(0);
  if (isIdentifierAtom(first) && first.value === "pub") {
    return expr;
  }
  if (!isIdentifierAtom(first) || !PUB_ELIGIBLE_TOP_LEVEL_HEADS.has(first.value)) {
    return expr;
  }

  return recreateForm(expr, [new IdentifierAtom("pub"), ...expr.toArray()]);
};

const isTopLevelAst = (form: Form): boolean =>
  form.callsInternal("ast") || form.calls("ast");

const isBlockLikeForm = (form: Form): boolean => {
  if (form.calls("block")) {
    return true;
  }

  const head = form.at(0);
  return isInternalIdentifierAtom(head) && head.value === "block";
};

const PUB_ELIGIBLE_TOP_LEVEL_HEADS = new Set([
  "fn",
  "type",
  "obj",
  "trait",
  "impl",
  "eff",
  "mod",
  "use",
  "macro",
  "macro_let",
  "functional-macro",
  "define-macro-variable",
]);

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

const parseMacroDefinition = ({
  form,
  strictMacroSignatures,
}: {
  form: Form;
  strictMacroSignatures: boolean;
}): MacroDefinitionInput | null => {
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
  if (!signatureExpr) {
    if (strictMacroSignatures) {
      throw new Error("macro missing signature");
    }
    return null;
  }
  if (!isForm(signatureExpr)) {
    if (strictMacroSignatures) {
      throw new Error("Expected form for macro signature");
    }
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
