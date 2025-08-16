import { Token } from "../token.js";
import { arrayLiteralMacro } from "./array-literal.js";
import { booleanMacro } from "./boolean.js";
import { comment } from "./comment.js";
import { mapLiteralMacro } from "./map-literal.js";
import { floatMacro } from "./float.js";
import { intMacro } from "./int.js";
import { scientificENotationMacro } from "./scientific-e-notation.js";
import { stringMacro } from "./string.js";
import { objectLiteralMacro } from "./object-literal.js";
import { ReaderMacro } from "./types.js";
import { genericsMacro } from "./generics.js";
import { Expr } from "../../syntax-objects/expr.js";
import { htmlMacro } from "./html/html.js";
import { listReader } from "./list.js";
import { whitespaceReader } from "./whitespace.js";
import { identifierReader } from "./identifier.js";

const MACROS = [
  listReader,
  whitespaceReader,
  objectLiteralMacro,
  arrayLiteralMacro,
  mapLiteralMacro,
  intMacro,
  floatMacro,
  scientificENotationMacro,
  stringMacro,
  comment,
  booleanMacro,
  genericsMacro,
  htmlMacro,
  identifierReader,
];

export const getReaderMacroForToken = (
  token: Token,
  prev?: Expr,
  /** Next char */
  next?: string
): ReaderMacro["macro"] | undefined =>
  MACROS.find((m) => m.match(token, prev, next))?.macro;
