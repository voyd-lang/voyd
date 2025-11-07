import {
  Atom,
  BoolAtom,
  CommentAtom,
  FloatAtom,
  IdentifierAtom,
  IntAtom,
  InternalIdentifierAtom,
  StringAtom,
  WhitespaceAtom,
} from "./atom.js";
import { CallForm, Form } from "./form.js";
import { Internal } from "./internals.js";
import { Syntax } from "./syntax.js";

export const isSyntax = (value: unknown): value is Syntax =>
  value instanceof Syntax;
export const isForm = (value: unknown): value is Form => value instanceof Form;
export const isCallForm = (value: unknown): value is CallForm =>
  value instanceof CallForm;
export const isAtom = (value: unknown): value is Atom => value instanceof Atom;
export const isIdentifierAtom = (value: unknown): value is IdentifierAtom =>
  value instanceof IdentifierAtom;
export const isInternalIdentifierAtom = (
  value: unknown
): value is InternalIdentifierAtom => value instanceof InternalIdentifierAtom;
export const isBoolAtom = (value: unknown): value is BoolAtom =>
  value instanceof BoolAtom;
export const isStringAtom = (value: unknown): value is StringAtom =>
  value instanceof StringAtom;
export const isCommentAtom = (value: unknown): value is CommentAtom =>
  value instanceof CommentAtom;
export const isIntAtom = (value: unknown): value is IntAtom =>
  value instanceof IntAtom;
export const isFloatAtom = (value: unknown): value is FloatAtom =>
  value instanceof FloatAtom;
export const isWhitespaceAtom = (value: unknown): value is WhitespaceAtom =>
  value instanceof WhitespaceAtom;

export const atomEq = (atom: unknown, value: string | Atom) =>
  isAtom(atom) && atom.eq(value);

export const formCalls = (form: unknown, value: string | IdentifierAtom) =>
  isForm(form) && form.calls(value);

export const formCallsInternal = (
  form: unknown,
  value: Internal | InternalIdentifierAtom
) => isForm(form) && form.callsInternal(value);
