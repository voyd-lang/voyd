// Create a module to work on
var module = new binaryen.Module();
module.autoDrop();

module.addGlobal("counter", binaryen.i32, true, module.i32.const(0))

module.addFunction('increment', [], binaryen.i32, [], module.block(null, [
  module.global.set("counter",
    module.i32.add(
      module.global.get("counter", binaryen.i32),
      module.i32.const(1)
    )
  ),
  module.return(module.global.get("counter", binaryen.i32))
]));
module.addFunctionExport('increment', 'increment');

// Print out the optimized module's text
console.log(module.emitText());

// Get the binary in typed array form
var binary = module.emitBinary();
console.log('binary size: ' + binary.length);
module.validate()

// We don't need the Binaryen module anymore, so we can tell it to
// clean itself up
module.dispose();

// Compile the binary and create an instance
var wasm = new WebAssembly.Instance(new WebAssembly.Module(binary), {})
console.log("exports: " + Object.keys(wasm.exports).sort().join(","));

console.log(wasm.exports.increment());
console.log(wasm.exports.increment());
console.log(wasm.exports.increment());

console.log("done");
