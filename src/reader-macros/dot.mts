import { ReaderMacro } from "./types.mjs";

/** Splits a token separated by dots when not a valid number */
export const dotMacro: ReaderMacro = {
  tag: /^[^1-9\s][^\s]*(\.[^1-9\s][^\s]+)+$/,
  macro: (_, token) => {
    return token
      .split(".")
      .reduce((prev, cur) => {
        prev.push(cur, ".");
        return prev;
      }, [] as string[])
      .slice(0, -2);
  },
};
