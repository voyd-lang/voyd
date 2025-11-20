import binaryen from "binaryen";
import type {
  CodegenContext,
  FunctionContext,
  FunctionMetadata,
  HirFunction,
} from "./context.js";
import { compileExpression } from "./expressions/index.js";
import { wasmTypeFor } from "./types.js";

export const registerFunctionMetadata = (ctx: CodegenContext): void => {
  for (const [itemId, item] of ctx.hir.items) {
    if (item.kind !== "function") continue;
    ctx.itemsToSymbols.set(itemId, item.symbol);

    const scheme = ctx.typing.table.getSymbolScheme(item.symbol);
    if (typeof scheme !== "number") {
      throw new Error(
        `codegen missing type scheme for function ${item.symbol}`
      );
    }

    const typeId = ctx.typing.arena.instantiate(scheme, []);
    const descriptor = ctx.typing.arena.get(typeId);
    if (descriptor.kind !== "function") {
      throw new Error(
        `codegen expected function type for symbol ${item.symbol}`
      );
    }

    const paramTypes = descriptor.parameters.map((param) =>
      wasmTypeFor(param.type, ctx)
    );
    const resultType = wasmTypeFor(descriptor.returnType, ctx);

    const metadata: FunctionMetadata = {
      symbol: item.symbol,
      wasmName: makeFunctionName(item, ctx),
      paramTypes,
      resultType,
      paramTypeIds: descriptor.parameters.map((param) => param.type),
      resultTypeId: descriptor.returnType,
    };

    ctx.functions.set(item.symbol, metadata);
  }
};

export const compileFunctions = (ctx: CodegenContext): void => {
  for (const item of ctx.hir.items.values()) {
    if (item.kind !== "function") continue;
    compileFunctionItem(item, ctx);
  }
};

export const emitExports = (ctx: CodegenContext): void => {
  ctx.hir.module.exports.forEach((entry) => {
    const symbol = ctx.itemsToSymbols.get(entry.item);
    if (typeof symbol !== "number") {
      return;
    }
    const meta = ctx.functions.get(symbol);
    if (!meta) {
      return;
    }
    const exportName =
      entry.alias ?? ctx.symbolTable.getSymbol(entry.symbol).name;
    ctx.mod.addFunctionExport(meta.wasmName, exportName);
  });
};

const compileFunctionItem = (fn: HirFunction, ctx: CodegenContext): void => {
  const meta = ctx.functions.get(fn.symbol);
  if (!meta) {
    throw new Error(`codegen missing metadata for function ${fn.symbol}`);
  }

  const fnCtx: FunctionContext = {
    bindings: new Map(),
    locals: [],
    nextLocalIndex: meta.paramTypes.length,
    returnTypeId: meta.resultTypeId,
  };

  fn.parameters.forEach((param, index) => {
    const type = meta.paramTypes[index];
    if (typeof type !== "number") {
      throw new Error(
        `codegen missing parameter type for symbol ${param.symbol}`
      );
    }
    fnCtx.bindings.set(param.symbol, { index, type });
  });

  const body = compileExpression(fn.body, ctx, fnCtx, true, fnCtx.returnTypeId);

  ctx.mod.addFunction(
    meta.wasmName,
    binaryen.createType(meta.paramTypes as number[]),
    meta.resultType,
    fnCtx.locals,
    body.expr
  );
};

const makeFunctionName = (fn: HirFunction, ctx: CodegenContext): string => {
  const moduleLabel = sanitizeIdentifier(ctx.hir.module.path);
  const symbolName = sanitizeIdentifier(
    ctx.symbolTable.getSymbol(fn.symbol).name
  );
  return `${moduleLabel}__${symbolName}_${fn.symbol}`;
};

const sanitizeIdentifier = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");
