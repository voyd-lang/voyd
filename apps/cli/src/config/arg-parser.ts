import { Command, InvalidArgumentError } from "commander";
import { createRequire } from "node:module";
import type { DocumentationFormat, VoydConfig } from "./types.js";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };

const DOC_FORMATS = ["html", "json"] as const;

const appendOptionValue = (value: string, previous: string[]): string[] => [
  ...previous,
  value,
];

const parseDocFormat = (value: string): DocumentationFormat => {
  const normalized = value.toLowerCase();
  if (normalized === "html" || normalized === "json") {
    return normalized;
  }
  throw new InvalidArgumentError(
    `invalid documentation format "${value}" (allowed: ${DOC_FORMATS.join(", ")})`,
  );
};

const createBaseCommand = ({
  name,
  description,
}: {
  name: string;
  description: string;
}): Command =>
  new Command()
    .name(name)
    .description(description)
    .version(version, "-v, --version", "display the current version")
    .helpOption("-h, --help", "display help for command")
    .allowExcessArguments();

const parseMainConfig = (argv: readonly string[]): VoydConfig => {
  const program = createBaseCommand({
    name: "voyd",
    description: "Voyd programming language CLI",
  });

  program
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
    .option("--run-entry <name>", "entry function to run (default: main)")
    .option("--internal-test", "run the internal test script")
    .option("--test", "run voyd tests")
    .option("--reporter <name>", "test reporter (default: minimal)")
    .option("--fail-empty-tests", "exit 1 if no tests are found")
    .option(
      "--pkg-dir <path>",
      "additional package directory (repeatable)",
      appendOptionValue,
      [],
    )
    .addHelpText(
      "after",
      [
        "",
        "Commands:",
        "  test [index]         run voyd tests",
        "  doc [index]          generate API documentation",
        "  docs [index]         alias for `doc`",
      ].join("\n"),
    );

  program.parse(["node", "voyd", ...argv]);
  const opts = program.opts();
  const [indexArg] = program.args as [string?];
  const testMode = Boolean(opts.test);
  const defaultIndex = testMode ? "." : "./src";

  return {
    index: indexArg ?? defaultIndex,
    emitParserAst: opts.emitParserAst,
    emitCoreAst: opts.emitCoreAst,
    emitIrAst: opts.emitIrAst,
    emitWasm: opts.emitWasm,
    emitWasmText: opts.emitWasmText,
    runBinaryenOptimizationPass: opts.opt,
    run: opts.run,
    runWasm: opts.runWasm,
    runEntry: opts.runEntry,
    test: testMode,
    testReporter: opts.reporter,
    failOnEmptyTests: opts.failEmptyTests,
    pkgDirs: opts.pkgDir,
    doc: false,
    docFormat: "html",
  };
};

const parseTestConfig = (argv: readonly string[]): VoydConfig => {
  const program = createBaseCommand({
    name: "voyd test",
    description: "Run voyd tests",
  });

  program
    .argument("[index]", "test root (default: .)")
    .option("--reporter <name>", "test reporter (default: minimal)")
    .option("--fail-empty-tests", "exit 1 if no tests are found")
    .option(
      "--pkg-dir <path>",
      "additional package directory (repeatable)",
      appendOptionValue,
      [],
    );

  program.parse(["node", "voyd test", ...argv]);
  const opts = program.opts();
  const [indexArg] = program.args as [string?];

  return {
    index: indexArg ?? ".",
    test: true,
    testReporter: opts.reporter,
    failOnEmptyTests: opts.failEmptyTests,
    pkgDirs: opts.pkgDir,
    doc: false,
    docFormat: "html",
  };
};

const parseDocConfig = (argv: readonly string[]): VoydConfig => {
  const program = createBaseCommand({
    name: "voyd doc",
    description: "Generate API documentation",
  });

  program
    .argument("[index]", "entry voyd file (default: ./src)")
    .option("--out <path>", "output path for generated documentation")
    .option(
      "--format <format>",
      `documentation format (${DOC_FORMATS.join("|")})`,
      parseDocFormat,
      "html",
    )
    .option(
      "--pkg-dir <path>",
      "additional package directory (repeatable)",
      appendOptionValue,
      [],
    );

  program.parse(["node", "voyd doc", ...argv]);
  const opts = program.opts();
  const [indexArg] = program.args as [string?];

  return {
    index: indexArg ?? "./src",
    pkgDirs: opts.pkgDir,
    doc: true,
    docOut: opts.out,
    docFormat: opts.format,
  };
};

const findSubcommandIndex = (args: readonly string[]): number => {
  const optionsWithValues = new Set(["--pkg-dir", "--reporter"]);

  let index = 0;
  while (index < args.length) {
    const arg = args[index]!;
    if (arg === "test" || arg === "doc" || arg === "docs") {
      return index;
    }

    if (arg === "--") {
      return -1;
    }

    if (optionsWithValues.has(arg)) {
      index += 2;
      continue;
    }

    const optionWithInlineValue = Array.from(optionsWithValues).some((option) =>
      arg.startsWith(`${option}=`),
    );
    if (optionWithInlineValue) {
      index += 1;
      continue;
    }

    index += 1;
  }

  return -1;
};

export const getConfigFromCli = (): VoydConfig => {
  const args = process.argv.slice(2);
  const commandIndex = findSubcommandIndex(args);
  if (commandIndex < 0) {
    return parseMainConfig(args);
  }

  const command = args[commandIndex]!;
  const rest = args.filter((_, index) => index !== commandIndex);

  if (command === "test") {
    return parseTestConfig(rest);
  }
  if (command === "doc" || command === "docs") {
    return parseDocConfig(rest);
  }
  return parseMainConfig(args);
};
