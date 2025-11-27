import type { BindingInputs, BindingContext, BindingResult } from "./types.js";
import { DeclTable } from "../decls.js";
import type { Syntax } from "../../parser/index.js";

export const createBindingContext = ({
  moduleForm,
  symbolTable,
}: BindingInputs): BindingContext => {
  const decls = new DeclTable();
  return {
    symbolTable,
    scopeByNode: new Map([[moduleForm.syntaxId, symbolTable.rootScope]]),
    decls,
    overloads: new Map(),
    overloadBySymbol: new Map(),
    diagnostics: [],
    overloadBuckets: new Map(),
    syntaxByNode: new Map([[moduleForm.syntaxId, moduleForm]]),
    nextModuleIndex: 0,
  };
};

export const toBindingResult = (ctx: BindingContext): BindingResult => ({
  symbolTable: ctx.symbolTable,
  scopeByNode: ctx.scopeByNode,
  decls: ctx.decls,
  functions: ctx.decls.functions,
  typeAliases: ctx.decls.typeAliases,
  objects: ctx.decls.objects,
  traits: ctx.decls.traits,
  impls: ctx.decls.impls,
  overloads: ctx.overloads,
  overloadBySymbol: ctx.overloadBySymbol,
  diagnostics: ctx.diagnostics,
});

export const rememberSyntax = (
  syntax: Syntax | undefined,
  ctx: Pick<BindingContext, "syntaxByNode">
): void => {
  if (!syntax) {
    return;
  }
  ctx.syntaxByNode.set(syntax.syntaxId, syntax);
};
