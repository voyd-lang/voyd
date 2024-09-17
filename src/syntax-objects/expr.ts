import type { Bool } from "./bool.js";
import type { Float } from "./float.js";
import type { Fn } from "./fn.js";
import type { Identifier } from "./identifier.js";
import type { Int } from "./int.js";
import type { List } from "./list.js";
import { Parameter } from "./parameter.js";
import type { StringLiteral } from "./string-literal.js";
import type { Type } from "./types.js";
import { Variable } from "./variable.js";
import type { Whitespace } from "./whitespace.js";
import type { Global } from "./global.js";
import { MacroVariable } from "./macro-variable.js";
import { Macro } from "./macros.js";
import { MacroLambda } from "./macro-lambda.js";
import { Call } from "./call.js";
import { Block } from "./block.js";
import { VoidModule } from "./module.js";
import { Declaration } from "./declaration.js";
import { Use } from "./use.js";
import { ObjectLiteral } from "./object-literal.js";
import { Match } from "./match.js";
import { Nop } from "./nop.js";
import { Implementation } from "./implementation.js";

export type Expr =
  | PrimitiveExpr
  | Type
  | Fn
  | Macro
  | Variable
  | Parameter
  | Global
  | MacroVariable
  | MacroLambda
  | VoidModule
  | Call
  | Block
  | Declaration
  | Use
  | ObjectLiteral
  | Match
  | Nop
  | Implementation;

/**
 * These are the Expr types that must be returned until all macros have been expanded (reader, syntax, and regular)
 */
export type PrimitiveExpr =
  | Bool
  | Int
  | Float
  | StringLiteral
  | Identifier
  | Whitespace
  | List;
