import {
  type IdentifierAtom,
  type InternalIdentifierAtom,
  type Syntax,
  identifierBindingKey,
  isIdentifierAtom,
  isInternalIdentifierAtom,
} from "../../parser/index.js";

export type BindableIdentifier = IdentifierAtom | InternalIdentifierAtom;

export const bindableIdentifierFromSyntax = (
  syntax: Syntax | undefined,
): BindableIdentifier | undefined =>
  isIdentifierAtom(syntax) || isInternalIdentifierAtom(syntax)
    ? syntax
    : undefined;

export const bindingIdentityForSyntax = (
  syntax: Syntax | undefined,
): string | undefined => {
  const identifier = bindableIdentifierFromSyntax(syntax);
  return identifier ? identifierBindingKey(identifier) : undefined;
};

export const bindingIdentityForIdentifier = (
  identifier: BindableIdentifier,
): string | undefined => identifierBindingKey(identifier);
