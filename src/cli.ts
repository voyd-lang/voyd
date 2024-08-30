#!/usr/bin/env node
import { stdout } from "process";
import { getConfig } from "./lib/config/index.js";
import { genWasmCode } from "./wasm-code-gen.js";
import { run } from "./run.js";
import { resolveFileModules } from "./modules.js";
import { expandRegularMacros } from "./regular-macros.js";
import { typeCheck } from "./semantics/index.js";
import binaryen from "binaryen";
import { resolveSrc } from "./lib/resolve-src.js";
import { testGc } from "./lib/binaryen-gc/test.js";
import { parseFile } from "./lib/index.js";
import { parseDirectory } from "./parser/api/parse-directory.js";
import { parseStd, stdPath } from "./parser/api/parse-std.js";

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

  if (config.emitWasmText) {
    return console.log(
      await getWasmText(config.index, config.runBinaryenOptimizationPass)
    );
  }

  if (config.emitWasm) {
    return emitWasm(config.index, config.runBinaryenOptimizationPass);
  }

  if (config.run) {
    return runWasm(config.index, config.runBinaryenOptimizationPass);
  }

  if (config.internalTest) {
    return testGc();
  }

  console.log(
    "I don't know what to do with the supplied options. Maybe try something else ¯_(ツ)_/¯"
  );
}

async function getParserAst(index: string) {
  return parseFile(index);
}

async function getCoreAst(index: string) {
  return await getParserAst(index);
}

async function getModuleAst(index: string) {
  const src = await resolveSrc(index);

  const srcFiles = src.srcRootPath
    ? await parseDirectory(src.srcRootPath)
    : { [src.indexPath]: await parseFile(src.indexPath) };

  const files = {
    ...srcFiles,
    ...(await parseStd()),
  };

  return resolveFileModules({
    files,
    srcPath: src.srcRootPath,
    indexPath: src.indexPath,
    stdPath: stdPath,
  });
}

async function getMacroAst(index: string) {
  const moduleAst = await getModuleAst(index);
  return expandRegularMacros(moduleAst);
}

async function getWasmMod(index: string, optimize = false) {
  const ast = await getMacroAst(index);
  const checkedAst = typeCheck(ast);
  const mod = genWasmCode(checkedAst);

  if (optimize) {
    binaryen.setShrinkLevel(3);
    binaryen.setOptimizeLevel(3);
    mod.optimize();
  }

  return mod;
}

async function getWasmText(index: string, optimize = false) {
  const mod = await getWasmMod(index, optimize);
  return mod.emitText();
}

async function emitWasm(index: string, optimize = false) {
  const mod = await getWasmMod(index, optimize);

  if (!mod.validate()) {
    throw new Error("Module is invalid");
  }

  stdout.write(mod.emitBinary());
}

async function runWasm(index: string, optimize = false) {
  const mod = await getWasmMod(index, optimize);

  if (!mod.validate()) {
    throw new Error("Module is invalid");
  }

  run(mod);
}

function emit(json: any) {
  console.log(JSON.stringify(json, undefined, 2));
}

function errorHandler(error: Error) {
  console.error(error);
  process.exit(1);
}
