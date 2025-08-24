import { Command } from "commander";
import { createRequire } from "node:module";
import { VoydConfig } from "./types.js";

const require = createRequire(import.meta.url);
const { version } = require("../../../package.json") as { version: string };

export const getConfigFromCli = (): VoydConfig => {
  const program = new Command();

  program
    .name("voyd")
    .description("Voyd programming language CLI")
    .version(version, "-v, --version", "display the current version")
    .argument("[index]", "entry voyd file", "./src")
    .option("--emit-parser-ast", "write raw parser AST to stdout")
    .option("--emit-core-ast", "write desurfaced AST to stdout")
    .option("--emit-ir-ast", "emit expanded IR AST after semantic phases")
    .option("--emit-wasm", "write wasm bytecode to stdout")
    .option(
      "--emit-wasm-text",
      "write wasm text format (binaryen flavor) to stdout"
    )
    .option("--opt", "have binaryen run its standard optimization pass")
    .option("-r, --run", "run the compiled wasm code")
    .option("--internal-test", "run the internal test script")
    .helpOption("-h, --help", "display help for command");

  program.parse();
  const opts = program.opts();
  const [index] = program.args as [string?];

  return {
    index: index ?? "./src",
    emitParserAst: opts.emitParserAst,
    emitCoreAst: opts.emitCoreAst,
    emitIrAst: opts.emitIrAst,
    emitWasm: opts.emitWasm,
    emitWasmText: opts.emitWasmText,
    runBinaryenOptimizationPass: opts.opt,
    run: opts.run,
    internalTest: opts.internalTest,
  };
};
