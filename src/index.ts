import { parse } from "./parser";
import fs from "fs";
import { syntaxMacros } from "./syntax-macros";

const file = fs.readFileSync(process.argv[2], { encoding: "utf8" });
const ast = syntaxMacros.reduce(
  (ast, macro) => macro(ast),
  parse(file.split(""))
);
console.log(JSON.stringify(ast, undefined, 2));
