import { parse } from "./parser.mjs";
import fs from "fs";
import { syntaxMacros } from "./syntax-macros/index.mjs";
import { genWasmCode } from "./wasm-code-gen.mjs";

const file = fs.readFileSync(process.argv[2], { encoding: "utf8" });
const ast = syntaxMacros.reduce(
  (ast, macro) => macro(ast),
  parse(file.split(""))
);

const mod = genWasmCode(ast);

const binary = mod.emitBinary();
const compiled = new WebAssembly.Module(binary);
const instance = new WebAssembly.Instance(compiled, {});
console.log((instance.exports as any).main0());
