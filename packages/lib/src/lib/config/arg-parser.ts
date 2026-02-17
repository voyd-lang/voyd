import { Command } from "commander";
import { createRequire } from "node:module";
import { VoydConfig } from "./types.js";

const require = createRequire(import.meta.url);
const { version } = require("@voyd/lib/package.json") as { version: string };

const appendOptionValue = (value: string, previous: string[]): string[] => [
  ...previous,
  value,
];

export const getConfigFromCli = (): VoydConfig => {
  const program = new Command();

  program
    .name("voyd")
    .description("Voyd programming language CLI")
    .version(version, "-v, --version", "display the current version")
    .argument("[index]", "entry voyd file (default: ./src)")
    .option("--emit-parser-ast", "write raw parser AST to stdout")
    .option("--emit-core-ast", "write desurfaced AST to stdout")
    .option("--emit-ir-ast", "emit expanded IR AST after semantic phases")
    .option("--emit-wasm", "write wasm bytecode to stdout")
    .option(
      "--emit-wasm-text",
      "write wasm text format (binaryen flavor) to stdout",
    )
    .option("--opt", "have binaryen run its standard optimization pass")
    .option("-m, --msg-pack", "decode message pack response")
    .option("-r, --run", "run voyd from src/ or provided path")
    .option("--run-wasm", "run the compiled wasm code directly")
    .option("--internal-test", "run the internal test script")
    .option("--test", "run voyd tests")
    .option("--out <path>", "output path for generated documentation")
    .option("--reporter <name>", "test reporter (default: minimal)")
    .option("--fail-empty-tests", "exit 1 if no tests are found")
    .option(
      "--pkg-dir <path>",
      "additional package directory (repeatable)",
      appendOptionValue,
      [],
    )
    .helpOption("-h, --help", "display help for command")
    .allowExcessArguments();

  program.parse(process.argv);
  const opts = program.opts();
  const [firstArg, secondArg] = program.args as [string?, string?];
  const isTestCommand = firstArg === "test";
  const isDocCommand = firstArg === "doc" || firstArg === "docs";
  const testMode = isTestCommand || opts.test;
  const docMode = isDocCommand;
  const indexArg = isTestCommand || isDocCommand ? secondArg : firstArg;
  const defaultIndex = testMode ? "." : "./src";

  return {
    index: indexArg ?? defaultIndex,
    emitParserAst: opts.emitParserAst,
    emitCoreAst: opts.emitCoreAst,
    emitIrAst: opts.emitIrAst,
    emitWasm: opts.emitWasm,
    emitWasmText: opts.emitWasmText,
    runBinaryenOptimizationPass: opts.opt,
    decodeMsgPackResponse: opts.msgPack,
    run: opts.run,
    runWasm: opts.runWasm,
    internalTest: opts.internalTest,
    test: testMode,
    testReporter: opts.reporter,
    failOnEmptyTests: opts.failEmptyTests,
    pkgDirs: opts.pkgDir,
    doc: docMode,
    docOut: opts.out,
  };
};
