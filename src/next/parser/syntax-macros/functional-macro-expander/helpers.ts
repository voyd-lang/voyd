import { Form } from "../../ast/form.js";
import {
  BoolAtom,
  Expr,
  FloatAtom,
  IdentifierAtom,
  IntAtom,
  isForm,
  isIdentifierAtom,
} from "../../ast/index.js";
import type { MacroEvalResult, MacroLambdaValue } from "./types.js";
import { isMacroLambdaValue } from "./types.js";

export const recreateForm = (form: Form, elements: Expr[]): Form =>
  new Form({
    location: form.location?.clone(),
    elements,
  });

export const ensureForm = (expr: Expr): Form =>
  isForm(expr) ? expr : new Form([expr]);

export const cloneExpr = (expr: Expr): Expr => expr.clone();

export const cloneMacroEvalResult = (
  value: MacroEvalResult
): MacroEvalResult => {
  if (isMacroLambdaValue(value)) {
    return {
      kind: "macro-lambda",
      parameters: value.parameters.map((param) => param.clone()),
      body: value.body.map(cloneExpr),
      scope: value.scope,
      id: value.id.clone(),
    } satisfies MacroLambdaValue;
  }

  return cloneExpr(value);
};

export const expectExpr = (
  value: MacroEvalResult | undefined,
  context = "macro evaluation"
): Expr => {
  if (!value) {
    throw new Error(`Expected expression for ${context}`);
  }

  if (isMacroLambdaValue(value)) {
    throw new Error(
      `Expected expression for ${context}, received macro lambda`
    );
  }

  return value;
};

export const expectForm = (
  expr: MacroEvalResult | undefined,
  context: string
): Form => {
  if (!isForm(expr)) {
    throw new Error(`Expected form for ${context}`);
  }
  return expr;
};

export const expectIdentifier = (
  expr: MacroEvalResult | undefined,
  context: string
): IdentifierAtom => {
  if (!isIdentifierAtom(expr)) {
    throw new Error(`Expected identifier for ${context}`);
  }
  return expr;
};

export const createInt = (value: number): IntAtom =>
  new IntAtom({ value: `${Math.trunc(value)}` });

export const createFloat = (value: number): FloatAtom =>
  new FloatAtom({ value: `${value}` });

export const createBool = (value: boolean): BoolAtom =>
  new BoolAtom({ value: value ? "true" : "false" });

export const bool = (value: unknown): BoolAtom => createBool(Boolean(value));
