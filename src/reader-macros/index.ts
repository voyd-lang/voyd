import { Token } from "../lib/token.js";
import { arrayLiteralMacro } from "./array-literal.js";
import { booleanMacro } from "./boolean.js";
import { comment } from "./comment.js";
import { dictionaryLiteralMacro } from "./dictionary-literal.js";
import { floatMacro } from "./float.js";
import { intMacro } from "./int.js";
import { scientificENotationMacro } from "./scientific-e-notation.js";
import { stringMacro } from "./string.js";
import { objectLiteralMacro } from "./object-literal.js";
import { ReaderMacro } from "./types.js";
import { genericsMacro } from "./generics.js";

const macros = [
  objectLiteralMacro,
  arrayLiteralMacro,
  dictionaryLiteralMacro,
  intMacro,
  floatMacro,
  scientificENotationMacro,
  stringMacro,
  comment,
  booleanMacro,
  genericsMacro,
];

export const getReaderMacroForToken = (
  token: Token,
  prev?: Token
): ReaderMacro["macro"] | undefined =>
  macros.find((m) => m.match(token, prev))?.macro;
