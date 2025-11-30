import { stdout } from "process";
import { getConfig } from "@voyd/lib/config/index.js";
import { run } from "@voyd/compiler/run.js";
import { processSemantics } from "@voyd/compiler/semantics/index.js";
import binaryen from "binaryen";
import { testGc } from "@voyd/lib/binaryen-gc/test.js";
import { parseFile, parseModuleFromSrc } from "@voyd/compiler/parser/index.js";
import { compileSrc } from "@voyd/compiler/compiler.js";
import { parse as newParse } from "@voyd/compiler-next/parser/parser";
import { readFileSync } from "fs";
import { semanticsPipeline } from "@voyd/compiler-next/semantics/pipeline";
import { codegen } from "@voyd/compiler-next/codegen/index";
import { getWasmInstance } from "@voyd/lib/wasm.js";
import type { Diagnostic } from "@voyd/compiler-next/diagnostics/index";
import { DiagnosticError } from "@voyd/compiler-next/diagnostics/index";
import { formatCliDiagnostic } from "./diagnostics.js";

export const exec = () => main().catch(errorHandler);

async function main() {
  const config = getConfig();

  if (config.canonical && config.emitParserAst) {
    const file = readFileSync(config.index, { encoding: "utf8" });
    const parsed = newParse(file, config.index);
    return emit(parsed.toJSON());
  }

  if (config.emitParserAst) {
    return emit(await getParserAst(config.index));
  }

  if (config.emitCoreAst) {
    return emit(await getCoreAst(config.index));
  }

  if (config.emitIrAst) {
    return emit(await getIrAST(config.index));
  }

  if (config.emitWasmText) {
    return console.log(
      await getWasmText(config.index, config.runBinaryenOptimizationPass)
    );
  }

  if (config.emitWasm) {
    return emitWasm(config.index, config.runBinaryenOptimizationPass);
  }

  if (config.canonical && config.run) {
    const main = nextLoadMain(config.index);
    const result = main();
    console.log(result);
    return;
  }

  if (config.run) {
    return runWasm(
      config.index,
      config.runBinaryenOptimizationPass,
      config.decodeMsgPackResponse
    );
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

async function getIrAST(index: string) {
  const module = await parseModuleFromSrc(index);
  return processSemantics(module);
}

async function getWasmMod(index: string, optimize = false) {
  const mod = await compileSrc(index);

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

async function runWasm(index: string, optimize = false, decodeMsgPack = false) {
  const mod = await getWasmMod(index, optimize);

  if (!mod.validate()) {
    throw new Error("Module is invalid");
  }

  run(mod, decodeMsgPack);
}

function emit(json: any) {
  console.log(JSON.stringify(json, undefined, 2));
}

function errorHandler(error: unknown) {
  const diagnostic = extractDiagnostic(error);
  if (diagnostic) {
    console.error(formatCliDiagnostic(diagnostic));
    process.exit(1);
  }

  console.error(error);
  process.exit(1);
}

const extractDiagnostic = (error: unknown): Diagnostic | undefined => {
  if (error instanceof DiagnosticError) {
    return error.diagnostic;
  }

  if (!error || typeof error !== "object" || !("diagnostic" in error)) {
    return undefined;
  }

  const candidate = (error as { diagnostic?: unknown }).diagnostic;
  return isDiagnostic(candidate) ? candidate : undefined;
};

const isDiagnostic = (value: unknown): value is Diagnostic => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const diagnostic = value as Partial<Diagnostic>;
  const span = diagnostic.span as
    | { file?: unknown; start?: unknown; end?: unknown }
    | undefined;

  if (!span) {
    return false;
  }

  const hasRequiredFields =
    typeof diagnostic.code === "string" &&
    typeof diagnostic.message === "string" &&
    typeof span.file === "string" &&
    typeof span.start === "number" &&
    typeof span.end === "number";

  return hasRequiredFields;
};

const nextLoadAst = (name: string) => {
  const source = readFileSync(name, "utf8");
  return newParse(source, name);
};

const nextLoadWasmInstance = (fixtureName: string) => {
  const ast = nextLoadAst(fixtureName);
  const semantics = semanticsPipeline(ast);
  const { module } = codegen(semantics);
  return getWasmInstance(module);
};

const nextLoadMain = (fixtureName: string) => {
  const instance = nextLoadWasmInstance(fixtureName);
  const main = instance.exports.main;
  return main as (...params: unknown[]) => unknown;
};
