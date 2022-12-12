import { importRootModule } from "./import-module.mjs";
import { StringsTable } from "./lib/host-runtime/strings.mjs";
import { genWasmCode } from "./wasm-code-gen.mjs";

const root = importRootModule();
// console.log(JSON.stringify(root, undefined, 2));
const mod = genWasmCode(root.ast);

if (!mod.validate()) {
  process.exit(1);
}

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
});

console.log((instance.exports as any).main0());
