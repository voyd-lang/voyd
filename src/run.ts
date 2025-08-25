import binaryen from "binaryen";
import { decode } from "@msgpack/msgpack";

export function run(mod: binaryen.Module, decodeMsgPack = false) {
  const binary: BufferSource = mod.emitBinary() as unknown as BufferSource;
  const compiled = new WebAssembly.Module(binary);
  const instance = new WebAssembly.Instance(compiled, {
    utils: {
      log: (val: number) => console.log(val),
    },
  });

  const fns = instance.exports as any;
  const result = fns.main();

  if (decodeMsgPack) {
    const memory = instance.exports["main_memory"] as WebAssembly.Memory;
    console.log(
      JSON.stringify(decode(memory.buffer.slice(0, result)), undefined, 2)
    );
    return;
  }

  console.log(result);
}
