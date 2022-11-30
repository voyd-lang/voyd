import { ReaderMacro } from "./types.mjs";

export const comment: ReaderMacro = {
  tag: /^\/\/[^\s]*$/,
  macro: (dream) => {
    while (dream.length) {
      const next = dream[0];
      if (next === "\n") break;
      dream.shift();
    }
    return undefined;
  },
};
