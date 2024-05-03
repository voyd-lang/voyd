import { ParseArgsConfig, parseArgs } from "node:util";
import { VoidConfig } from "./types.mjs";

const options: ParseArgsConfig["options"] = {
  "emit-parser-ast": {
    type: "boolean",
  },
  "emit-core-ast": {
    type: "boolean",
  },
  "emit-module-ast": {
    type: "boolean",
  },
  "emit-macro-ast": {
    type: "boolean",
  },
  "emit-wasm": {
    type: "boolean",
  },
  "emit-wasm-text": {
    type: "boolean",
  },
  /** Tells binaryen to run its standard optimization pass */
  opt: {
    type: "boolean",
  },
  run: {
    type: "boolean",
    short: "r",
  },
  help: {
    type: "boolean",
    short: "h",
  },
  version: {
    type: "boolean",
    short: "v",
  },
};

export const getConfigFromCli = (): VoidConfig => {
  const { values, positionals } = parseArgs({
    options,
    allowPositionals: true,
  });

  const index = positionals[0];

  if (typeof index !== "string") {
    throw new Error("Expected void entry file path");
  }

  return {
    index,
    emitParserAst: values["emit-parser-ast"] as boolean,
    emitCoreAst: values["emit-core-ast"] as boolean,
    emitModuleAst: values["emit-module-ast"] as boolean,
    emitMacroAst: values["emit-macro-ast"] as boolean,
    emitWasm: values["emit-wasm"] as boolean,
    emitWasmText: values["emit-wasm-text"] as boolean,
    runBinaryenOptimizationPass: values["opt"] as boolean,
    showHelp: values["help"] as boolean,
    showVersion: values["version"] as boolean,
    run: values["run"] as boolean,
  };
};
