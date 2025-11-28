// Browser-friendly entry point.
// Exposes only APIs that work in the browser bundle (no Node fs/glob).

export { compile, compileParsedModule } from "./compiler-browser.js";
export { parse } from "@voyd/compiler/parser/parser.js";
export * from "@voyd/lib/wasm.js";
