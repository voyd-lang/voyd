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
  const newStringReader = fns.new_string_reader;
  const read_next_char = fns.read_next_char;
  const result = fns.main();
  const reader = newStringReader(result);

  let str = "";
  while (true) {
    const char = read_next_char(reader);
    if (char < 0) {
      break;
    }
    str += String.fromCharCode(char);
  }

  console.log(str);
}
