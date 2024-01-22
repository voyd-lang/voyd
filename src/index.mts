#!/usr/bin/env node
import { stdout } from "process";
import { getConfig } from "./config/index.mjs";
import { genWasmCode } from "./wasm-code-gen.mjs";
import { run } from "./run.mjs";
import { parseFile, parseStd, stdPath } from "./lib/index.mjs";
import {
  expandSyntaxMacrosOfFiles,
  expandSyntaxMacros,
} from "./syntax-macros/index.mjs";
import { resolveFileModules } from "./modules.mjs";
import path from "path";

async function main() {
  const config = getConfig();

  if (config.emitParserAst) {
    const parserAst = await parseFile(config.index);
    console.log(JSON.stringify(parserAst, undefined, 2));
    return;
  }

  if (config.emitCoreAst) {
    const parserAst = await parseFile(config.index);
    console.log(JSON.stringify(expandSyntaxMacros(parserAst), undefined, 2));
    return;
  }

  if (config.emitModuleAst) {
    const indexFilePath = path.resolve(config.index);
    const parsedFiles = {
      [indexFilePath]: await parseFile(indexFilePath),
      ...(await parseStd()),
    };
    const files = expandSyntaxMacrosOfFiles(parsedFiles);

    const module = resolveFileModules({
      files,
      srcPath: path.dirname(indexFilePath),
      stdPath: stdPath,
    });

    console.log(JSON.stringify(module, undefined, 2));
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

main().catch((error) => {
  // Catch cause binaryen dumps its whole codebase to stdout if we don't
  console.error(error);
  process.exit(1);
});
