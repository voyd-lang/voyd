import { Bool } from "./bool.mjs";
import { Float } from "./float.mjs";
import { Identifier } from "./identifier.mjs";
import { Int } from "./int.mjs";
import { List } from "./list.mjs";
import { StringLiteral } from "./string-literal.mjs";
import { Type } from "./types.mjs";
import { Whitespace } from "./whitespace.mjs";

export type Expr =
  | Comment
  | Bool
  | Int
  | Float
  | StringLiteral
  | Identifier
  | Whitespace
  | List
  | Type;
