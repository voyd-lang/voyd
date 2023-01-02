import { Bool } from "./bool.mjs";
import { Float } from "./float.mjs";
import { Identifier } from "./identifier.mjs";
import type { Id } from "./identifier.mjs";
import { Int } from "./int.mjs";
import { List } from "./list.mjs";
import { StringLiteral } from "./string-literal.mjs";
import { PrimitiveType, StructType } from "./types.mjs";
import { Whitespace } from "./whitespace.mjs";

export const isStringLiteral = (expr: unknown): expr is StringLiteral =>
  expr instanceof StringLiteral;
export const isList = (expr?: unknown): expr is List => expr instanceof List;
export const isFloat = (expr?: unknown): expr is Float => expr instanceof Float;
export const isInt = (expr?: unknown): expr is Int => expr instanceof Int;
export const isBool = (expr?: unknown): expr is Bool => expr instanceof Bool;
export const isWhitespace = (expr?: unknown): expr is Whitespace =>
  expr instanceof Whitespace;
export const isStructType = (expr?: unknown): expr is StructType =>
  expr instanceof StructType;
export const isPrimitiveType = (expr?: unknown): expr is PrimitiveType =>
  expr instanceof PrimitiveType;
export const isIdentifier = (expr?: unknown): expr is Identifier =>
  expr instanceof Identifier;
export const newLine = () => new Whitespace({ value: "\n" });
