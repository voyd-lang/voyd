import { stringMacro } from "./double-quote";
import { ReaderMacro } from "./types";

const macros = [stringMacro];

export const readerMacros = macros.reduce((map, reader) => {
  map.set(reader.tag, reader.macro);
  return map;
}, new Map<string, ReaderMacro["macro"]>());
