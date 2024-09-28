import { getWasmFn } from "./wasm.js";

/** Read a string returned by a voyd function call */
export const readString = (ref: Object, instance: WebAssembly.Instance) => {
  const newStringIterator = getWasmFn("new_string_iterator", instance)!;
  const readNextChar = getWasmFn("read_next_char", instance)!;
  const reader = newStringIterator(ref);

  let str = "";
  while (true) {
    const char = readNextChar(reader);
    if (char < 0) {
      break;
    }
    str += String.fromCharCode(char);
  }

  return str;
};
