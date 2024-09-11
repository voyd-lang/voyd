import { List } from "./list.js";
import { Whitespace } from "./whitespace.js";

export const newLine = () => new Whitespace({ value: "\n" });
export const noop = () => new List({ value: ["splice_quote"] });
