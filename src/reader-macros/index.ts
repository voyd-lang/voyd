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

export const readerMacros = macros.reduce((map, reader) => {
  map.set(reader.tag, reader.macro);
  return map;
}, new Map<string, ReaderMacro["macro"]>());
