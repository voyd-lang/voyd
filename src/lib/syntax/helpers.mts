import { Bool } from "./bool.mjs";
import { Expr } from "./expr.mjs";
import { Float } from "./float.mjs";
import { Identifier } from "./identifier.mjs";
import { Int } from "./int.mjs";
import { List } from "./list.mjs";
import { StringLiteral } from "./string-literal.mjs";
import { Whitespace } from "./whitespace.mjs";

export const isStringLiteral = (expr: Expr): expr is StringLiteral =>
  expr instanceof StringLiteral;
export const isList = (expr?: Expr): expr is List => expr instanceof List;
export const isFloat = (expr?: Expr): expr is Float => expr instanceof Float;
export const isInt = (expr?: Expr): expr is Int => expr instanceof Int;
export const isBool = (expr?: Expr): expr is Bool => expr instanceof Bool;
export const isWhitespace = (expr?: Expr): expr is Whitespace =>
  expr instanceof Whitespace;
export const isIdentifier = (expr?: Expr): expr is Identifier =>
  expr instanceof Identifier;
export const newLine = () => new Whitespace({ value: "\n" });
