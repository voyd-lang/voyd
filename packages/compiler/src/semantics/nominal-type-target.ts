import {
  type Expr,
  formCallsInternal,
  isForm,
  isIdentifierAtom,
  isInternalIdentifierAtom,
} from "../parser/index.js";
import type { SymbolTable } from "./binder/index.js";
import type { ScopeId, SymbolId } from "./ids.js";

export type NominalTypeTarget = {
  name: string;
  typeArguments?: readonly Expr[];
};

export const extractNominalTypeTarget = (
  target: Expr | undefined,
): NominalTypeTarget | undefined => {
  if (!target) {
    return undefined;
  }
  if (isIdentifierAtom(target) || isInternalIdentifierAtom(target)) {
    return { name: target.value };
  }
  if (!isForm(target)) {
    return undefined;
  }
  if (formCallsInternal(target, "generics")) {
    const nominal = extractNominalTypeTarget(target.at(1));
    if (!nominal) {
      return undefined;
    }
    const typeArguments = target.rest.slice(1);
    return typeArguments.length > 0
      ? { ...nominal, typeArguments }
      : nominal;
  }
  if (target.length === 2) {
    const head = target.at(0);
    const second = target.at(1);
    if (
      (isIdentifierAtom(head) || isInternalIdentifierAtom(head)) &&
      isForm(second) &&
      formCallsInternal(second, "generics")
    ) {
      return second.rest.length > 0
        ? { name: head.value, typeArguments: second.rest }
        : { name: head.value };
    }
  }
  return undefined;
};

export const extractNominalTypeName = (
  target: Expr | undefined,
): string | undefined => extractNominalTypeTarget(target)?.name;

export const resolveNominalTypeSymbol = ({
  target,
  scope,
  symbolTable,
}: {
  target: Expr | undefined;
  scope: ScopeId;
  symbolTable: SymbolTable;
}): SymbolId | undefined => {
  const name = extractNominalTypeName(target);
  if (!name) {
    return undefined;
  }
  const symbol = symbolTable.resolve(name, scope);
  return typeof symbol === "number" ? symbol : undefined;
};
