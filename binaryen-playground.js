const binaryen = require("binaryen");

const mod = new binaryen.Module();

mod.autoDrop();

mod.addGlobal("counter", binaryen.i32, true, mod.i32.const(0))
mod.addFunctionImport("log", "imports", "log", binaryen.i32, binaryen.none);

mod.addFunction('increment', binaryen.none, binaryen.none, [], mod.block("", [
  mod.global.set("counter",
    mod.i32.add(
      mod.global.get("counter", binaryen.i32),
      mod.i32.const(1)
    )
  )
]));

mod.addFunction('main', binaryen.none, binaryen.none, [], mod.block("", [
  mod.call("increment", [], binaryen.none, binaryen.none),
  mod.call("increment", [], binaryen.none, binaryen.none),
  mod.call("increment", [], binaryen.none, binaryen.none),
  mod.call("log", [mod.global.get("counter", binaryen.i32)], binaryen.none)
]));
mod.addFunctionExport('main', 'main');

if (!mod.validate()) throw new Error("Invalid module");

// Get the binary in typed array form
const binary = mod.emitBinary();
console.log(mod.emitText());

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
