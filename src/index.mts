import { importRootModule } from "./import-module.mjs";
import { genWasmCode } from "./wasm-code-gen.mjs";

const root = importRootModule();
// console.log(JSON.stringify(root, undefined, 2));
const mod = genWasmCode(root.ast);

const binary = mod.emitBinary();
const compiled = new WebAssembly.Module(binary);
const instance = new WebAssembly.Instance(compiled, {});
console.log((instance.exports as any).main0());
