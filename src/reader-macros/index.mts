import { Token } from "../lib/token.mjs";
import { arrayLiteralMacro } from "./array-literal.mjs";
import { booleanMacro } from "./boolean.mjs";
import { comment } from "./comment.mjs";
import { dictionaryLiteralMacro } from "./dictionary-literal.mjs";
import { floatMacro } from "./float.mjs";
import { intMacro } from "./int.mjs";
import { scientificENotationMacro } from "./scientific-e-notation.mjs";
import { stringMacro } from "./string.mjs";
import { structLiteralMacro } from "./struct-literal.mjs";
import { tupleLiteralMacro } from "./tuple-literal.mjs";
import { ReaderMacro } from "./types.mjs";

const macros = [
  structLiteralMacro,
  tupleLiteralMacro,
  arrayLiteralMacro,
  dictionaryLiteralMacro,
  intMacro,
  floatMacro,
  scientificENotationMacro,
  stringMacro,
  comment,
  booleanMacro,
];

const readerMacros = macros.reduce(
  ({ map, patterns }, reader) => {
    if (typeof reader.tag === "string") {
      map.set(reader.tag, reader.macro);
      return { map, patterns };
    }

    patterns.push({ pattern: reader.tag, macro: reader.macro });
    return { map, patterns };
  },
  {
    map: new Map<string, ReaderMacro["macro"]>(),
    patterns: [] as { pattern: RegExp; macro: ReaderMacro["macro"] }[],
  }
);

export const getReaderMacroForToken = (
  token: Token
): ReaderMacro["macro"] | undefined => {
  return (
    readerMacros.map.get(token.value) ??
    readerMacros.patterns.find(({ pattern }) => pattern.test(token.value))
      ?.macro
  );
};
