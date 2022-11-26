import { ReaderMacro } from "./types.mjs";

export const stringMacro: ReaderMacro = {
  tag: /^[\"\']$/,
  macro: (dream, { token }) => {
    let string = token;
    while (dream.length) {
      const next = dream.shift();

      if (next === "\\") {
        string += next;
        string += dream.shift();
        continue;
      }

      if (next === token) {
        string += token;
        break;
      }

      string += next;
    }
    return string;
  },
};
