import binaryen from "binaryen";
import { readString } from "./lib/read-string.js";

export function run(mod: binaryen.Module) {
  const binary = mod.emitBinary();
  const compiled = new WebAssembly.Module(binary);
  const instance = new WebAssembly.Instance(compiled, {
    utils: {
      log: (val: number) => console.log(val),
    },
  });

  const fns = instance.exports as any;
  const result = fns.main();

  if (typeof result === "object") {
    console.log(readString(result, instance));
    return;
  }

  console.log(result);
}
