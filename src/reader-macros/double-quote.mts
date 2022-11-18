import { AST } from "../parser.mjs";
import { ReaderMacro } from "./types.mjs";

const macro = (dream: string[]): AST => {
  let string = "";

  while (dream.length) {
    const char = dream.shift();

    if (char === "\\") {
      string += dream.shift();
      continue;
    }

    if (char === '"') {
      break;
    }

    string += char;
  }

  return ["string", string];
};

export const stringMacro: ReaderMacro = {
  tag: '"',
  macro,
};
