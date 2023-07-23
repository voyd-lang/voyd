#!/usr/bin/env node
import { stdout } from "process";
import { getConfig } from "./config/index.mjs";
import { importRootModule, parseFile } from "./import-module.mjs";
import { genWasmCode } from "./wasm-code-gen.mjs";
import { run } from "./run.mjs";

function main() {
  const config = getConfig();

  if (config.emitParserAst) {
    console.log(JSON.stringify(parseFile(config.index), undefined, 2));
    return;
  }

  const root = importRootModule();
  if (config.emitSyntaxAst) {
    console.log(JSON.stringify(root, undefined, 2));
    return;
  }

  const mod = genWasmCode(root.ast);
  if (!mod.validate()) {
    throw new Error("Module is invalid");
  }

  if (config.emitWasm) {
    stdout.write(mod.emitBinary());
    return;
  }

  if (config.run) {
    run(mod);
    return;
  }

  console.log(
    "I don't know what to do with the supplied options. Maybe try something else ¯_(ツ)_/¯"
  );
}

try {
  main();
} catch (error) {
  // Catch cause binaryen dumps its whole codebase to stdout if we don't
  console.error(error);
  process.exit(1);
}
