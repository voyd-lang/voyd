import type { Bool } from "./bool.mjs";
import type { Float } from "./float.mjs";
import type { Fn } from "./fn.mjs";
import type { Identifier } from "./identifier.mjs";
import type { Int } from "./int.mjs";
import type { List } from "./list.mjs";
import { Parameter } from "./parameter.mjs";
import type { StringLiteral } from "./string-literal.mjs";
import type { Type } from "./types.mjs";
import { Variable } from "./variable.mjs";
import type { Whitespace } from "./whitespace.mjs";
import type { Global } from "./global.mjs";

export type Expr =
  | Bool
  | Int
  | Float
  | StringLiteral
  | Identifier
  | Whitespace
  | List
  | Type
  | Fn
  | Variable
  | Parameter
  | Global;
