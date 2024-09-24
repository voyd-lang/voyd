import binaryen from "binaryen";

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

  console.log(result);
}
