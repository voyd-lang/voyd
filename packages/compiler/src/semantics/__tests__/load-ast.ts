import { parse } from "../../parser/index.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const loadAst = (fixtureName: string) => {
  const source = readFileSync(
    resolve(import.meta.dirname, "__fixtures__", fixtureName),
    "utf8"
  );
  return parse(source, fixtureName);
};
