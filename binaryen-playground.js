const binaryen = require("binaryen");

const mod = new binaryen.Module();

mod.autoDrop();
mod.setFeatures(512);
mod.addFunctionImport("log", "imports", "log", [binaryen.i32], binaryen.none);

const tupleType = binaryen.createType([
  binaryen.i32,
  binaryen.i32, binaryen.i32,
  binaryen.i32
]);

mod.addFunction("make-tuple", binaryen.none, tupleType, [], mod.block("", [
  mod.return(mod.tuple.make([
    mod.i32.const(1),
    mod.i32.const(2), mod.i32.const(22),
    mod.i32.const(3)
  ]))
]));

mod.addFunction('main', binaryen.none, binaryen.none, [tupleType], mod.block("", [
  mod.local.set(0, mod.call("make-tuple", [], tupleType)),
  mod.call("log", [mod.tuple.extract(mod.local.get(0, tupleType), 0)], binaryen.none),
  mod.call("log", [mod.tuple.extract(mod.local.get(0, tupleType), 2)], binaryen.none),
]));

mod.addFunctionExport('main', 'main');

if (!mod.validate()) throw new Error("Invalid module");

mod.optimize();

// Get the binary in typed array form
const binary = mod.emitBinary();

// We don't need the Binaryen module anymore, so we can tell it to
// clean itself up
mod.dispose();

// Compile the binary and create an instance
const wasm = new WebAssembly.Instance(new WebAssembly.Module(binary), {
  imports: {
    log(i) {
      console.log(i)
    }
  }
});

wasm.exports.main();
