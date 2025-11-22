import binaryen from "binaryen";
import type {
  CodegenContext,
  FunctionContext,
  FunctionMetadata,
  HirFunction,
  TypeId,
} from "./context.js";
import { compileExpression } from "./expressions/index.js";
import { wasmTypeFor } from "./types.js";

export const registerFunctionMetadata = (ctx: CodegenContext): void => {
  const unknown = ctx.typing.arena.internPrimitive("unknown");

  for (const [itemId, item] of ctx.hir.items) {
    if (item.kind !== "function") continue;
    ctx.itemsToSymbols.set(itemId, item.symbol);

    const scheme = ctx.typing.table.getSymbolScheme(item.symbol);
    if (typeof scheme !== "number") {
      throw new Error(
        `codegen missing type scheme for function ${item.symbol}`
      );
    }

    const schemeInfo = ctx.typing.arena.getScheme(scheme);
    const instantiationInfo = ctx.typing.functionInstantiationInfo.get(
      item.symbol
    );
    const instantiations =
      instantiationInfo && instantiationInfo.size > 0
        ? Array.from(instantiationInfo.entries())
        : getDefaultInstantiationArgs({
            symbol: item.symbol,
            params: schemeInfo.params.length,
            unknown,
          });

    instantiations.forEach(([instanceKey, typeArgs]) => {
      if (ctx.functionInstances.has(instanceKey)) {
        return;
      }

      const typeId = ctx.typing.arena.instantiate(scheme, typeArgs);
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
        wasmName: makeFunctionName(item, ctx, typeArgs),
        paramTypes,
        resultType,
        paramTypeIds: descriptor.parameters.map((param) => param.type),
        resultTypeId: descriptor.returnType,
        typeArgs,
        instanceKey,
      };

      const metas = ctx.functions.get(item.symbol);
      if (metas) {
        metas.push(metadata);
      } else {
        ctx.functions.set(item.symbol, [metadata]);
      }
      ctx.functionInstances.set(instanceKey, metadata);
    });
  }
};

export const compileFunctions = (ctx: CodegenContext): void => {
  for (const item of ctx.hir.items.values()) {
    if (item.kind !== "function") continue;
    const metas = ctx.functions.get(item.symbol);
    if (!metas || metas.length === 0) {
      throw new Error(`codegen missing metadata for function ${item.symbol}`);
    }
    metas.forEach((meta) => compileFunctionItem(item, meta, ctx));
  }
};

export const emitExports = (ctx: CodegenContext): void => {
  ctx.hir.module.exports.forEach((entry) => {
    const symbol = ctx.itemsToSymbols.get(entry.item);
    if (typeof symbol !== "number") {
      return;
    }
    const metas = ctx.functions.get(symbol);
    const meta =
      metas?.find((candidate) => candidate.typeArgs.length === 0) ?? metas?.[0];
    if (!meta) {
      return;
    }
    const exportName =
      entry.alias ?? ctx.symbolTable.getSymbol(entry.symbol).name;
    ctx.mod.addFunctionExport(meta.wasmName, exportName);
  });
};

const compileFunctionItem = (
  fn: HirFunction,
  meta: FunctionMetadata,
  ctx: CodegenContext
): void => {
  const fnCtx: FunctionContext = {
    bindings: new Map(),
    locals: [],
    nextLocalIndex: meta.paramTypes.length,
    returnTypeId: meta.resultTypeId,
    instanceKey: meta.instanceKey,
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

  const body = compileExpression({
    exprId: fn.body,
    ctx,
    fnCtx,
    tailPosition: true,
    expectedResultTypeId: fnCtx.returnTypeId,
  });

  ctx.mod.addFunction(
    meta.wasmName,
    binaryen.createType(meta.paramTypes as number[]),
    meta.resultType,
    fnCtx.locals,
    body.expr
  );
};

const makeFunctionName = (
  fn: HirFunction,
  ctx: CodegenContext,
  typeArgs: readonly TypeId[]
): string => {
  const moduleLabel = sanitizeIdentifier(ctx.hir.module.path);
  const symbolName = sanitizeIdentifier(
    ctx.symbolTable.getSymbol(fn.symbol).name
  );
  const suffix =
    typeArgs.length === 0 ? "" : `__inst_${sanitizeIdentifier(typeArgs.join("_"))}`;
  return `${moduleLabel}__${symbolName}_${fn.symbol}${suffix}`;
};

const sanitizeIdentifier = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");
const getDefaultInstantiationArgs = ({
  symbol,
  params,
  unknown,
}: {
  symbol: number;
  params: number;
  unknown: TypeId;
}): [string, readonly TypeId[]][] => {
  if (params === 0) {
    return [[formatInstanceKey(symbol, []), []]];
  }
  if (params < 0) {
    throw new Error("function has invalid type parameter count");
  }
  const args = Array.from({ length: params }, () => unknown);
  return [[formatInstanceKey(symbol, args), args]];
};

const formatInstanceKey = (
  symbol: number,
  typeArgs: readonly TypeId[]
): string => `${symbol}<${typeArgs.join(",")}>`;
