import binaryen from "binaryen";
import { StringsTable } from "./lib/host-runtime/strings.mjs";

export function run(mod: binaryen.Module) {
  const binary = mod.emitBinary();
  const compiled = new WebAssembly.Module(binary);
  const strings = new StringsTable();
  const instance = new WebAssembly.Instance(compiled, {
    strings: {
      "alloc-string": () => strings.allocString(),
      "de-alloc-string": (index: number) => strings.deAllocString(index),
      "add-char-code-to-string": (code: number, index: number) =>
        strings.addCharCodeToString(code, index),
      "str-len": (index: number) => strings.strLength(index),
      "print-str": (index: number) => strings.printStr(index),
      "get-char-code-from-string": (charIndex: number, strIndex: number) =>
        strings.getCharCodeFromString(charIndex, strIndex),
      "str-equals": (aIndex: number, bIndex: number) =>
        strings.strEquals(aIndex, bIndex),
      "str-starts-with": (aIndex: number, bIndex: number) =>
        strings.strStartsWith(aIndex, bIndex),
      "str-ends-with": (aIndex: number, bIndex: number) =>
        strings.strEndsWith(aIndex, bIndex),
      "str-includes": (aIndex: number, bIndex: number) =>
        strings.strIncludes(aIndex, bIndex),
      "str-test": (strIndex: number, regexIndex: number, flagsIndex: number) =>
        strings.strTest(strIndex, regexIndex, flagsIndex),
    },
    utils: {
      log: (val: number) => console.log(val),
    },
  });

  console.log((instance.exports as any).main());
}
