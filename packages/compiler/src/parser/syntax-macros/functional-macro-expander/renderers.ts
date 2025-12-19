import { Form } from "../../ast/form.js";
import { IdentifierAtom } from "../../ast/index.js";
import type { MacroDefinition, MacroVariableBinding } from "./types.js";
import { cloneExpr } from "./helpers.js";

export const renderFunctionalMacro = (macro: MacroDefinition): Form =>
  new Form([
    new IdentifierAtom("functional-macro"),
    macro.id.clone(),
    new Form([
      new IdentifierAtom("parameters"),
      ...macro.parameters.map((param) => param.clone()),
    ]),
    new Form([new IdentifierAtom("block"), ...macro.body.map(cloneExpr)]),
  ]);

export const renderMacroVariable = (
  binding: MacroVariableBinding
): Form =>
  new Form([
    new IdentifierAtom("define-macro-variable"),
    binding.name.clone(),
    new Form([new IdentifierAtom("reserved-for-type")]),
    new Form([
      new IdentifierAtom("is-mutable"),
      binding.mutable
        ? new IdentifierAtom("true")
        : new IdentifierAtom("false"),
    ]),
  ]);
