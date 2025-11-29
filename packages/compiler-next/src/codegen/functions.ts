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
  const exportedItems = new Set(
    ctx.hir.module.exports.map((entry) => entry.item)
  );

  for (const [itemId, item] of ctx.hir.items) {
    if (item.kind !== "function") continue;
    ctx.itemsToSymbols.set(itemId, { moduleId: ctx.moduleId, symbol: item.symbol });

    const symbolRecord = ctx.symbolTable.getSymbol(item.symbol);
    const intrinsicMetadata = (symbolRecord.metadata ?? {}) as {
      intrinsic?: boolean;
      intrinsicUsesSignature?: boolean;
    };
    if (intrinsicMetadata.intrinsic && intrinsicMetadata.intrinsicUsesSignature !== true) {
      continue;
    }

    const scheme = ctx.typing.table.getSymbolScheme(item.symbol);
    if (typeof scheme !== "number") {
      throw new Error(
        `codegen missing type scheme for function ${item.symbol}`
      );
    }

    const schemeInfo = ctx.typing.arena.getScheme(scheme);
    const instantiationInfo = ctx.typing.functionInstantiationInfo.get(item.symbol);
    const recordedInstantiations =
      instantiationInfo && instantiationInfo.size > 0
        ? Array.from(instantiationInfo.entries())
        : [];
    if (recordedInstantiations.length === 0 && schemeInfo.params.length > 0) {
      const name = ctx.symbolTable.getSymbol(item.symbol).name;
      const exported = exportedItems.has(itemId) ? "exported " : "";
      throw new Error(
        `codegen requires a concrete instantiation for ${exported}generic function ${name}`
      );
    }
    const instantiations: [string, readonly TypeId[]][] =
      recordedInstantiations.length > 0
        ? recordedInstantiations
        : getDefaultInstantiationArgs({
            symbol: item.symbol,
            params: schemeInfo.params.length,
          });

    instantiations.forEach(([instanceKey, typeArgs]) => {
      if (typeArgs.some((arg) => arg === unknown)) {
        const name = ctx.symbolTable.getSymbol(item.symbol).name;
        throw new Error(
          `codegen cannot emit ${name} without resolved type arguments (instance ${instanceKey})`
        );
      }
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
        moduleId: ctx.moduleId,
        symbol: item.symbol,
        wasmName: makeFunctionName(item, ctx, typeArgs),
        paramTypes,
        resultType,
        paramTypeIds: descriptor.parameters.map((param) => param.type),
        resultTypeId: descriptor.returnType,
        typeArgs,
        instanceKey,
      };

      const key = functionKey(ctx.moduleId, item.symbol);
      const metas = ctx.functions.get(key);
      if (metas) {
        metas.push(metadata);
      } else {
        ctx.functions.set(key, [metadata]);
      }
      ctx.functionInstances.set(scopedInstanceKey(ctx.moduleId, instanceKey), metadata);
    });
  }
};

export const compileFunctions = (ctx: CodegenContext): void => {
  for (const item of ctx.hir.items.values()) {
    if (item.kind !== "function") continue;
    const symbolRecord = ctx.symbolTable.getSymbol(item.symbol);
    const intrinsicMetadata = (symbolRecord.metadata ?? {}) as {
      intrinsic?: boolean;
      intrinsicUsesSignature?: boolean;
    };
    if (intrinsicMetadata.intrinsic && intrinsicMetadata.intrinsicUsesSignature !== true) {
      continue;
    }
    const metas = ctx.functions.get(functionKey(ctx.moduleId, item.symbol));
    if (!metas || metas.length === 0) {
      throw new Error(`codegen missing metadata for function ${item.symbol}`);
    }
    metas.forEach((meta) => compileFunctionItem(item, meta, ctx));
  }
};

export const registerImportMetadata = (ctx: CodegenContext): void => {
  ctx.binding.imports.forEach((imp) => {
    if (!imp.target) return;
    if (imp.target.moduleId === ctx.moduleId) return;
    const symbolRecord = ctx.symbolTable.getSymbol(imp.local);
    const intrinsicMetadata = (symbolRecord.metadata ?? {}) as {
      intrinsic?: boolean;
      intrinsicUsesSignature?: boolean;
    };
    if (intrinsicMetadata.intrinsic && intrinsicMetadata.intrinsicUsesSignature !== true) {
      return;
    }

    const signature = ctx.typing.functions.getSignature(imp.local);
    if (!signature) return;

    const targetKey = functionKey(imp.target.moduleId, imp.target.symbol);
    const targetMetas = ctx.functions.get(targetKey);
    if (!targetMetas || targetMetas.length === 0) {
      return;
    }

    const schemeId = ctx.typing.table.getSymbolScheme(imp.local);
    const scheme =
      typeof schemeId === "number" ? ctx.typing.arena.getScheme(schemeId) : undefined;
    const typeParamCount = signature.typeParams?.length ?? scheme?.params.length ?? 0;
    const instantiationInfo = ctx.typing.functionInstantiationInfo.get(imp.local);
    const recordedInstantiations =
      instantiationInfo && instantiationInfo.size > 0
        ? Array.from(instantiationInfo.entries())
        : [];
    if (recordedInstantiations.length === 0 && typeParamCount > 0) {
      const name = ctx.symbolTable.getSymbol(imp.local).name;
      throw new Error(
        `codegen requires a concrete instantiation for imported generic function ${name}`
      );
    }
    const instantiations: [string, readonly TypeId[]][] =
      recordedInstantiations.length > 0
        ? recordedInstantiations
        : [[formatInstanceKey(imp.local, []), []]];

    instantiations.forEach(([instanceKey, typeArgs]) => {
      const targetMeta = pickTargetMeta(targetMetas, typeArgs.length);
      const paramTypes = signature.parameters.map((param) =>
        wasmTypeFor(param.type, ctx)
      );
      const resultType = wasmTypeFor(signature.returnType, ctx);
      const metadata: FunctionMetadata = {
        moduleId: ctx.moduleId,
        symbol: imp.local,
        wasmName: (targetMeta ?? targetMetas[0]!).wasmName,
        paramTypes,
        resultType,
        paramTypeIds: signature.parameters.map((param) => param.type),
        resultTypeId: signature.returnType,
        typeArgs,
        instanceKey,
      };
      const key = functionKey(ctx.moduleId, imp.local);
      const metas = ctx.functions.get(key);
      if (metas) {
        metas.push(metadata);
      } else {
        ctx.functions.set(key, [metadata]);
      }
      ctx.functionInstances.set(scopedInstanceKey(ctx.moduleId, instanceKey), metadata);
    });
  });
};

export const emitModuleExports = (ctx: CodegenContext): void => {
  ctx.hir.items.forEach((item) => {
    if (item.kind !== "function") return;
    if (item.visibility !== "public") return;
    const symbolRecord = ctx.symbolTable.getSymbol(item.symbol);
    const intrinsicMetadata = (symbolRecord.metadata ?? {}) as {
      intrinsic?: boolean;
      intrinsicUsesSignature?: boolean;
    };
    if (
      intrinsicMetadata.intrinsic &&
      intrinsicMetadata.intrinsicUsesSignature !== true
    ) {
      return;
    }
    const metas = ctx.functions.get(functionKey(ctx.moduleId, item.symbol));
    const meta =
      metas?.find((candidate) => candidate.typeArgs.length === 0) ?? metas?.[0];
    if (!meta) {
      return;
    }
    const exportName = ctx.symbolTable.getSymbol(item.symbol).name;
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
  const symbolName = sanitizeIdentifier(
    ctx.symbolTable.getSymbol(fn.symbol).name
  );
  const suffix =
    typeArgs.length === 0 ? "" : `__inst_${sanitizeIdentifier(typeArgs.join("_"))}`;
  return `${ctx.moduleLabel}__${symbolName}_${fn.symbol}${suffix}`;
};

const sanitizeIdentifier = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");
const getDefaultInstantiationArgs = ({
  symbol,
  params,
}: {
  symbol: number;
  params: number;
}): [string, readonly TypeId[]][] => {
  if (params === 0) {
    return [[formatInstanceKey(symbol, []), []]];
  }
  throw new Error(
    "getDefaultInstantiationArgs should only be used for non-generic functions"
  );
};

const formatInstanceKey = (
  symbol: number,
  typeArgs: readonly TypeId[]
): string => `${symbol}<${typeArgs.join(",")}>`;

const functionKey = (moduleId: string, symbol: number): string =>
  `${moduleId}::${symbol}`;

const scopedInstanceKey = (
  moduleId: string,
  instanceKey: string
): string => `${moduleId}::${instanceKey}`;

const pickTargetMeta = (
  metas: readonly FunctionMetadata[],
  typeArgCount: number
): FunctionMetadata | undefined =>
  metas.find((meta) => meta.typeArgs.length === typeArgCount) ?? metas[0];
