import { Module } from "binaryen";

/** Run a binaryen module */
export async function run(mod: Module): Promise<void> {
    mod.validate();
    mod.optimize();
    const bin = mod.emitBinary();
    await runBinary(bin);
    mod.dispose();
}

/** Run a compiled WASM binary */
export function runBinary(bin: Uint8Array): Promise<void> {
    return WebAssembly.instantiate(bin, {
        imports: {
            print(v: number) {
                console.log(v);
            },
            panic() {
                throw new Error("PANIC!!!");
            }
        }
    }).then(result => {
        const { main, memory } = result.instance.exports as any;

        // Set the stack frame address to proper starting location
        const buffer = new Uint32Array(memory.buffer);
        buffer[0] = 4;

        // Execute main function of the dream module.
        main();
    }).catch(console.error);
}
