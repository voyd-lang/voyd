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
import { expandRegularMacros } from "./regular-macros.mjs";

main().catch(errorHandler);

async function main() {
  const config = getConfig();

  if (config.emitParserAst) {
    return emit(await getParserAst(config.index));
  }

  if (config.emitCoreAst) {
    return emit(await getCoreAst(config.index));
  }

  if (config.emitModuleAst) {
    return emit(await getModuleAst(config.index));
  }

  if (config.emitMacroAst) {
    return emit(await getMacroAst(config.index));
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

async function getParserAst(index: string) {
  return parseFile(index);
}

async function getCoreAst(index: string) {
  const parserAst = await getParserAst(index);
  return expandSyntaxMacros(parserAst);
}

async function getModuleAst(index: string) {
  const indexFilePath = path.resolve(index);
  const parsedFiles = {
    [indexFilePath]: await parseFile(indexFilePath),
    ...(await parseStd()),
  };
  const files = expandSyntaxMacrosOfFiles(parsedFiles);

  return resolveFileModules({
    files,
    srcPath: path.dirname(indexFilePath),
    stdPath: stdPath,
  });
}

async function getMacroAst(index: string) {
  const moduleAst = await getModuleAst(index);
  return expandRegularMacros(moduleAst);
}

function emit(json: any) {
  console.log(JSON.stringify(json, undefined, 2));
}

function errorHandler(error: Error) {
  console.error(error);
  process.exit(1);
}
