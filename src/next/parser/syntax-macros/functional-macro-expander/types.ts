import type { Form } from "../../ast/form.js";
import type { Expr, IdentifierAtom } from "../../ast/index.js";
import type { MacroScope } from "./scope.js";

export type MacroEvalResult = Expr | MacroLambdaValue;

export type MacroLambdaValue = {
  kind: "macro-lambda";
  parameters: IdentifierAtom[];
  body: Expr[];
  scope: MacroScope;
  id: IdentifierAtom;
};

export type MacroVariableBinding = {
  name: IdentifierAtom;
  value: MacroEvalResult;
  mutable: boolean;
};

export type MacroDefinition = {
  name: IdentifierAtom;
  parameters: IdentifierAtom[];
  body: Expr[];
  scope: MacroScope;
  id: IdentifierAtom;
};

export type EvalOpts = {
  skipBuiltins?: Set<string>;
};

export type BuiltinContext = {
  call: Form;
  args: MacroEvalResult[];
  originalArgs: Expr[];
  scope: MacroScope;
};

export type BuiltinFn = (ctx: BuiltinContext) => MacroEvalResult;

export const isMacroLambdaValue = (
  value: unknown
): value is MacroLambdaValue => {
  return typeof value === "object" && (value as MacroLambdaValue)?.kind === "macro-lambda";
};
