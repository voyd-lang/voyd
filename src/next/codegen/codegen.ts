import binaryen from "binaryen";
import type {
  CodegenContext,
  CodegenOptions,
  CodegenResult,
  SemanticsPipelineResult,
} from "./context.js";
import { createRttContext } from "./rtt/index.js";
import {
  compileFunctions,
  emitExports,
  registerFunctionMetadata,
} from "./functions.js";

const DEFAULT_OPTIONS: Required<CodegenOptions> = {
  optimize: false,
  validate: true,
};

export const codegen = (
  semantics: SemanticsPipelineResult,
  options: CodegenOptions = {}
): CodegenResult => {
  const mod = new binaryen.Module();
  mod.setFeatures(binaryen.Features.All);
  const rtt = createRttContext(mod);
  const ctx: CodegenContext = {
    mod,
    symbolTable: semantics.symbolTable,
    hir: semantics.hir,
    typing: semantics.typing,
    options: { ...DEFAULT_OPTIONS, ...options },
    functions: new Map(),
    itemsToSymbols: new Map(),
    structTypes: new Map(),
    rtt,
  };

  registerFunctionMetadata(ctx);
  compileFunctions(ctx);
  emitExports(ctx);

  if (ctx.options.optimize) {
    mod.optimize();
  }

  if (ctx.options.validate) {
    mod.validate();
  }

  return { module: mod };
};

export type { CodegenOptions, CodegenResult } from "./context.js";
