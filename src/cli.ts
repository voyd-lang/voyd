#!/usr/bin/env node
import { stdout } from "process";
import { getConfig } from "./lib/config/index.js";
import { assemble } from "./assembler.js";
import { run } from "./run.js";
import { processSemantics } from "./semantics/index.js";
import binaryen from "binaryen";
import { testGc } from "./lib/binaryen-gc/test.js";
import { parseFile, parseModuleFromSrc } from "./parser/index.js";

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
  const module = await parseModuleFromSrc(index);
  return processSemantics(module);
}

async function getMacroAst(index: string) {
  const module = await parseModuleFromSrc(index);
  return processSemantics(module);
}

async function getWasmMod(index: string, optimize = false) {
  const module = await parseModuleFromSrc(index);
  const checkedAst = processSemantics(module);
  const mod = assemble(checkedAst);

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
