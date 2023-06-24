import binaryen from "binaryen";

try {
  const mod = new binaryen.Module();
  mod.setMemory(1, 150, "buffer");
  mod.setFeatures(binaryen.Features.All);
  const tuple = binaryen.createType([binaryen.i32, binaryen.i32]);

  mod.addFunction(
    "main",
    binaryen.createType([]),
    binaryen.i32,
    [tuple, tuple],
    mod.block(
      null,
      [
        mod.local.set(0, mod.tuple.make([mod.i32.const(1), mod.i32.const(2)])),
        mod.local.set(1, mod.local.get(0, tuple)),
        mod.tuple.extract(mod.local.get(1, tuple), 1),
        mod.tuple.extract(mod.local.get(0, tuple), 0),
      ],
      binaryen.auto
    )
  );
  mod.addFunctionExport("main", "main");
  mod.autoDrop();

  if (!mod.validate()) {
    process.exit(1);
  } else {
    console.log(mod.emitStackIR());
    const binary = mod.emitBinary();
    const compiled = new WebAssembly.Module(binary);
    const instance = new WebAssembly.Instance(compiled, {});
    // console.log(instance.exports.main());
  }
} catch (error) {
  console.log(error);
}
