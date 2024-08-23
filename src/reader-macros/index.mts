import { Token } from "../lib/token.mjs";
import { arrayLiteralMacro } from "./array-literal.mjs";
import { booleanMacro } from "./boolean.mjs";
import { comment } from "./comment.mjs";
import { dictionaryLiteralMacro } from "./dictionary-literal.mjs";
import { floatMacro } from "./float.mjs";
import { intMacro } from "./int.mjs";
import { scientificENotationMacro } from "./scientific-e-notation.mjs";
import { stringMacro } from "./string.mjs";
import { objectLiteralMacro } from "./object-literal.mjs";
import { ReaderMacro } from "./types.mjs";
import { genericsMacro } from "./generics.mjs";

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
