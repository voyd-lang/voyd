import { Command } from "commander";
import { createRequire } from "node:module";
import { VoydConfig } from "./types.js";

const require = createRequire(import.meta.url);
const { version } = require("@voyd/lib/package.json") as { version: string };

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
      "write wasm text format (binaryen flavor) to stdout"
    )
    .option("--opt", "have binaryen run its standard optimization pass")
    .option("-m, --msg-pack", "decode message pack response")
    .option("-r, --run", "run the compiled wasm code")
    .option("--internal-test", "run the internal test script")
    .option("--test", "run voyd tests")
    .option("--reporter <name>", "test reporter (default: minimal)")
    .helpOption("-h, --help", "display help for command")
    .allowExcessArguments();

  program.parse(process.argv);
  const opts = program.opts();
  const [firstArg, secondArg] = program.args as [string?, string?];
  const isTestCommand = firstArg === "test";
  const testMode = isTestCommand || opts.test;
  const indexArg = isTestCommand ? secondArg : firstArg;
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
    internalTest: opts.internalTest,
    test: testMode,
    testReporter: opts.reporter,
  };
};
