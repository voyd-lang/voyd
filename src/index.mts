import { importRootModule } from "./import-module.mjs";

const root = importRootModule();
console.log(JSON.stringify(root.module, undefined, 2));

// const mod = genWasmCode(ast);

// const binary = mod.emitBinary();
// const compiled = new WebAssembly.Module(binary);
// const instance = new WebAssembly.Instance(compiled, {});
// console.log((instance.exports as any).main0());
