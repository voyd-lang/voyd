import { Command, InvalidArgumentError } from "commander";
import { createRequire } from "node:module";
import type { OptimizationLevel } from "@voyd-lang/sdk";
import type {
  BootstrapTemplate,
  DocumentationFormat,
  VoydConfig,
} from "./types.js";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };

const DOC_FORMATS = ["html", "json"] as const;
const BOOTSTRAP_TEMPLATES = ["vx-spa", "web-ssr"] as const;
const OPTIMIZATION_LEVELS = ["none", "balanced", "release"] as const;
const MAIN_OPTIONS_WITH_VALUES = [
  "--pkg-dir",
  "--entry",
  "--opt-level",
] as const;

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

const parseBootstrapTemplate = (value: string): BootstrapTemplate => {
  const normalized = value.toLowerCase();
  if (normalized === "vx-spa" || normalized === "web-ssr") {
    return normalized;
  }
  throw new InvalidArgumentError(
    `invalid bootstrap template "${value}" (allowed: ${BOOTSTRAP_TEMPLATES.join(", ")})`,
  );
};

const parseOptimizationLevel = (value: string): OptimizationLevel => {
  const normalized = value.toLowerCase();
  if (
    normalized === "none" ||
    normalized === "balanced" ||
    normalized === "release"
  ) {
    return normalized;
  }
  throw new InvalidArgumentError(
    `invalid optimization level "${value}" (allowed: ${OPTIMIZATION_LEVELS.join(", ")})`,
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

const findFirstPositionalArg = (
  args: readonly string[],
  optionsWithValues: ReadonlySet<string>,
): string | undefined => {
  let index = 0;
  while (index < args.length) {
    const arg = args[index]!;

    if (arg === "--") {
      return args[index + 1];
    }

    if (optionsWithValues.has(arg)) {
      index += 2;
      continue;
    }

    const optionWithInlineValue = Array.from(optionsWithValues).some((option) =>
      arg.startsWith(`${option}=`),
    );
    if (optionWithInlineValue || arg.startsWith("-")) {
      index += 1;
      continue;
    }

    return arg;
  }

  return undefined;
};

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
    .option("--opt", "apply Voyd's release optimization profile")
    .option(
      "--opt-level <level>",
      `optimization level (${OPTIMIZATION_LEVELS.join("|")})`,
    )
    .option("-m, --msg-pack", "decode message pack response")
    .option("-r, --run", "run voyd from src/ or provided path")
    .option("--run-wasm", "run the compiled wasm code directly")
    .option("--entry <name>", "entry function to run (default: main)")
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
        "  bootstrap [dir]      scaffold a new Voyd project",
        "  generate adapter     generate host adapter bindings",
      ].join("\n"),
    );

  program.parse(["node", "voyd", ...argv]);
  const opts = program.opts();
  if (opts.opt && opts.optLevel !== undefined) {
    throw new InvalidArgumentError(
      "--opt and --opt-level cannot be used together",
    );
  }
  const optimizationLevel = opts.optLevel
    ? parseOptimizationLevel(opts.optLevel)
    : opts.opt
      ? "release"
      : "none";
  const indexArg = findFirstPositionalArg(
    argv,
    new Set(MAIN_OPTIONS_WITH_VALUES),
  );

  return {
    index: indexArg ?? "./src",
    emitParserAst: opts.emitParserAst,
    emitCoreAst: opts.emitCoreAst,
    emitIrAst: opts.emitIrAst,
    emitWasm: opts.emitWasm,
    emitWasmText: opts.emitWasmText,
    optimizationLevel,
    run: opts.run,
    runWasm: opts.runWasm,
    entry: opts.entry,
    pkgDirs: opts.pkgDir,
    doc: false,
    docFormat: "html",
  };
};

const parseBootstrapConfig = (argv: readonly string[]): VoydConfig => {
  const program = createBaseCommand({
    name: "voyd bootstrap",
    description: "Scaffold a new Voyd project",
  });

  program
    .argument("[dir]", "project directory (default: .)")
    .option(
      "--template <name>",
      `starter template (${BOOTSTRAP_TEMPLATES.join("|")})`,
      parseBootstrapTemplate,
      "vx-spa",
    )
    .option("--dry-run", "print files that would be created without writing")
    .option("-f, --force", "allow writing into a non-empty directory");

  program.parse(["node", "voyd bootstrap", ...argv]);
  const opts = program.opts();
  const [dirArg] = program.args as [string?];

  return {
    index: "./src",
    bootstrap: true,
    bootstrapDir: dirArg ?? ".",
    bootstrapTemplate: opts.template,
    bootstrapDryRun: opts.dryRun,
    bootstrapForce: opts.force,
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

const parseGenerateConfig = (argv: readonly string[]): VoydConfig => {
  const program = createBaseCommand({
    name: "voyd generate adapter",
    description: "Generate package adapter bindings or an application registry",
  });

  program
    .argument("<kind>", "artifact kind (adapter|registry)")
    .argument("[index]", "package entry (default: ./src)")
    .option(
      "--out <path>",
      "output path (adapter default: ./generated/voyd-adapter; registry default: ./generated/voyd-adapters.ts)",
    )
    .option(
      "--pkg-dir <path>",
      "additional package directory (repeatable)",
      appendOptionValue,
      [],
    );

  program.parse(["node", "voyd generate", ...argv]);
  const opts = program.opts();
  const [kind, indexArg] = program.args as [string, string?];
  if (kind !== "adapter" && kind !== "registry") {
    throw new InvalidArgumentError(
      `invalid generation kind "${kind}" (allowed: adapter, registry)`,
    );
  }
  return {
    index: indexArg ?? "./src",
    pkgDirs: opts.pkgDir,
    generateAdapter: kind === "adapter",
    generateAdapterRegistry: kind === "registry",
    generateOut: opts.out,
    doc: false,
    docFormat: "html",
  };
};

const findSubcommandIndex = (args: readonly string[]): number => {
  const optionsWithValues: ReadonlySet<string> = new Set(
    MAIN_OPTIONS_WITH_VALUES,
  );

  let index = 0;
  while (index < args.length) {
    const arg = args[index]!;
    if (
      arg === "test" ||
      arg === "doc" ||
      arg === "docs" ||
      arg === "bootstrap" ||
      arg === "generate"
    ) {
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
  if (command === "bootstrap") {
    return parseBootstrapConfig(rest);
  }
  if (command === "generate") {
    return parseGenerateConfig(rest);
  }
  return parseMainConfig(args);
};
