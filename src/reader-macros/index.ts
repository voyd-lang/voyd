import { stringMacro } from "./double-quote";
import { structLiteralMacro } from "./struct-literal";
import { ReaderMacro } from "./types";

const macros = [stringMacro, structLiteralMacro];

export const readerMacros = macros.reduce((map, reader) => {
  map.set(reader.tag, reader.macro);
  return map;
}, new Map<string, ReaderMacro["macro"]>());
