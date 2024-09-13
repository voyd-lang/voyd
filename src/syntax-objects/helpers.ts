import { Nop } from "./nop.js";
import { Whitespace } from "./whitespace.js";

export const newLine = () => new Whitespace({ value: "\n" });

let nopCache: Nop | undefined = undefined;
export const nop = () => {
  if (!nopCache) {
    const n = new Nop({});
    nopCache = n;
    return n;
  }

  return nopCache;
};
