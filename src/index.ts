import { parse } from "./parser";
import fs from "fs";
import { macros } from "./macros";

const file = fs.readFileSync(process.argv[2], { encoding: "utf8" });
const ast = macros.reduce((ast, macro) => macro(ast), parse(file.split("")));
console.log(JSON.stringify(ast, undefined, 2));
