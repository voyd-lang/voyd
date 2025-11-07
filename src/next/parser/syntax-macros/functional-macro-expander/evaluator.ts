import { Form } from "../../ast/form.js";
import { Expr, IdentifierAtom, isForm, isIdentifierAtom } from "../../ast/index.js";
import { Syntax } from "../../ast/syntax.js";
import { createBuiltins, fnsToSkipArgEval } from "./builtins.js";
import {
  cloneExpr,
  cloneMacroEvalResult,
  expectExpr,
  recreateForm,
} from "./helpers.js";
import { MacroScope } from "./scope.js";
import type {
  EvalOpts,
  MacroDefinition,
  MacroEvalResult,
  MacroLambdaValue,
} from "./types.js";
import { isMacroLambdaValue } from "./types.js";

export function evalMacroExpr(
  expr: Expr,
  scope: MacroScope,
  opts: EvalOpts = {}
): MacroEvalResult {
  if (isIdentifierAtom(expr)) {
    const value = scope.getVariable(expr.value)?.value;
    return value ? cloneMacroEvalResult(value) : expr;
  }

  if (!isForm(expr)) return expr;

  if (expr.calls("block")) {
    return evalBlock(expr, scope);
  }

  return evalCall(expr, scope, opts);
}

function evalBlock(block: Form, scope: MacroScope): MacroEvalResult {
  const childScope = scope.child();
  let result: MacroEvalResult = new IdentifierAtom("nop");

  block
    .toArray()
    .slice(1)
    .forEach((expression) => {
      result = evalMacroExpr(expression, childScope);
    });

  return result;
}

function evalCall(
  form: Form,
  scope: MacroScope,
  opts: EvalOpts
): MacroEvalResult {
  const head = form.at(0);
  if (!isIdentifierAtom(head)) {
    const evaluated = form
      .toArray()
      .map((expression) => expectExpr(evalMacroExpr(expression, scope, opts)));
    return recreateForm(form, evaluated);
  }

  const id = head.value;
  const macro = scope.getMacro(id);
  if (macro) {
    const expanded = expandMacroCall(form, macro, scope);
    return evalMacroExpr(expanded, scope, opts);
  }

  const argExprs = form.toArray().slice(1);
  const args: MacroEvalResult[] = fnsToSkipArgEval.has(id)
    ? argExprs
    : argExprs.map((expression) => evalMacroExpr(expression, scope, opts));

  const builtin = builtins[id];
  if (builtin && !opts.skipBuiltins?.has(id)) {
    return builtin({
      call: form,
      args,
      originalArgs: argExprs,
      scope,
    });
  }

  const evaluatedHead = evalMacroExpr(head, scope, opts);
  if (isMacroLambdaValue(evaluatedHead)) {
    return callLambda(
      evaluatedHead,
      args.filter((value): value is Expr => value instanceof Syntax)
    );
  }

  const normalizedArgs = args.map((arg) => expectExpr(arg));
  return recreateForm(form, [expectExpr(evaluatedHead), ...normalizedArgs]);
}

export function expandMacroCall(
  call: Form,
  macro: MacroDefinition,
  scope: MacroScope
): Expr {
  const invocationScope = new MacroScope(macro.scope);
  const args = call.toArray().slice(1).map(cloneExpr);
  const bodyArguments = new Form({
    location: call.location?.clone(),
    elements: args.map(cloneExpr),
  });

  invocationScope.defineVariable({
    name: new IdentifierAtom("body"),
    value: bodyArguments,
    mutable: false,
  });

  macro.parameters.forEach((param, index) => {
    const supplied = args.at(index);
    if (!supplied) {
      throw new Error(
        `Macro ${macro.name.value} expected ${macro.parameters.length} arguments, received ${index}`
      );
    }
    invocationScope.defineVariable({
      name: param.clone(),
      value: cloneExpr(supplied),
      mutable: false,
    });
  });

  let result: MacroEvalResult = new IdentifierAtom("nop");
  macro.body.forEach((expression) => {
    result = evalMacroExpr(cloneExpr(expression), invocationScope);
  });

  const normalized = expectExpr(result, "macro expansion result");
  if (call.location) normalized.setLocation(call.location.clone());
  return normalized;
}

function callLambda(lambda: MacroLambdaValue, args: Expr[]): MacroEvalResult {
  const lambdaScope = new MacroScope(lambda.scope);
  lambdaScope.defineVariable({
    name: new IdentifierAtom("&lambda"),
    value: cloneMacroEvalResult(lambda),
    mutable: false,
  });

  lambda.parameters.forEach((param, index) => {
    const arg = args.at(index);
    if (!arg) {
      throw new Error(
        `Lambda expected ${lambda.parameters.length} arguments, received ${index}`
      );
    }
    lambdaScope.defineVariable({
      name: param.clone(),
      value: cloneExpr(arg),
      mutable: false,
    });
  });

  let result: MacroEvalResult = new IdentifierAtom("nop");
  lambda.body.forEach((expression) => {
    result = evalMacroExpr(cloneExpr(expression), lambdaScope);
  });

  return result;
}

const builtins = createBuiltins({
  evalMacroExpr,
  callLambda,
});
