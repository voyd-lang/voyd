import { importRootModule } from "./import-module.mjs";
import { genWasmCode } from "./wasm-code-gen.mjs";

const root = importRootModule();
// console.log(JSON.stringify(root, undefined, 2));
const mod = genWasmCode(root.ast);

const binary = mod.emitBinary();
const compiled = new WebAssembly.Module(binary);
const instance = new WebAssembly.Instance(compiled, {
  strings: {
    "alloc-string": () => 0,
    "de-alloc-string": () => 0,
    "add-char-code-to-string": () => 0,
    "str-len": () => 0,
    printstr: () => 0,
    "get-char-code-from-string": () => 0,
  },
});
console.log((instance.exports as any).main0());
