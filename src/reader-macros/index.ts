import { arrayLiteralMacro } from "./array-literal";
import { dictionaryLiteralMacro } from "./dictionary-literal";
import { stringMacro } from "./double-quote";
import { structLiteralMacro } from "./struct-literal";
import { tupleLiteralMacro } from "./tuple-literal";
import { ReaderMacro } from "./types";

const macros = [
  stringMacro,
  structLiteralMacro,
  tupleLiteralMacro,
  arrayLiteralMacro,
  dictionaryLiteralMacro,
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
  token: string
): ReaderMacro["macro"] | undefined => {
  return (
    readerMacros.map.get(token) ??
    readerMacros.patterns.find(({ pattern }) => pattern.test(token))?.macro
  );
};
