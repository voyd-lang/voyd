import { List } from "./list.mjs";
import { Whitespace } from "./whitespace.mjs";

export const newLine = () => new Whitespace({ value: "\n" });
export const noop = () => new List({ value: ["splice_quote"] });
