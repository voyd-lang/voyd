import binaryen, { Module } from "binaryen";

/** Run a binaryen module */
export async function run(mod: Module) {
    mod.validate();
    mod.optimize();
    const bin = mod.emitBinary();
    await runBinary(bin);
    mod.dispose();
}

/** Run a compiled WASM binary */
export function runBinary(bin: Uint8Array) {
    return WebAssembly.instantiate(bin, {
        imports: {
            print(v: number) {
                console.log(v);
            }
        }
    }).then(result => {
        const exports = result.instance.exports;
        (exports as any).main();
    }).catch(console.error);
}
