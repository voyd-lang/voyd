import binaryen from "binaryen";
import { defineStructType } from "@voyd/lib/binaryen-gc/index.js";
import type { AugmentedBinaryen } from "@voyd/lib/binaryen-gc/types.js";
import type { ClosureTypeInfo, CodegenContext, TypeId } from "./context.js";

const bin = binaryen as unknown as AugmentedBinaryen;

const sanitizeIdentifier = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");

type WasmTypeMode = "runtime" | "signature";

export const getFunctionRefType = ({
  params,
  result,
  ctx,
  label,
}: {
  params: readonly binaryen.Type[];
  result: binaryen.Type;
  ctx: CodegenContext;
  label?: string;
}): binaryen.Type => {
  const key = `${params.join(",")}->${result}`;
  const cached = ctx.functionRefTypes.get(key);
  if (cached) {
    return cached;
  }
  const safeLabel = label ? `_${sanitizeIdentifier(label)}` : "";
  const tempName = `__fn_sig_${ctx.functionRefTypes.size}${safeLabel}`;
  const fnRef = ctx.mod.addFunction(
    tempName,
    binaryen.createType(params as number[]),
    result,
    [],
    ctx.mod.nop()
  );
  const fnType = bin._BinaryenTypeFromHeapType(
    bin._BinaryenFunctionGetType(fnRef),
    false
  );
  ctx.functionRefTypes.set(key, fnType);
  ctx.mod.removeFunction(tempName);
  return fnType;
};

const closureSignatureKey = ({
  moduleId,
  parameters,
  returnType,
  effectRow,
}: {
  moduleId: string;
  parameters: ReadonlyArray<{
    type: TypeId;
    label?: string;
    optional?: boolean;
  }>;
  returnType: TypeId;
  effectRow: unknown;
}): string => {
  const params = parameters
    .map((param) => {
      const label = param.label ?? "_";
      const optional = param.optional ? "?" : "";
      return `${label}:${param.type}${optional}`;
    })
    .join("|");
  return `${moduleId}::(${params})->${returnType}|${effectRow}`;
};

const closureStructName = ({
  moduleLabel,
  key,
}: {
  moduleLabel: string;
  key: string;
}): string => `${moduleLabel}__closure_base_${sanitizeIdentifier(key)}`;

const getClosureFunctionRefType = ({
  params,
  result,
  ctx,
}: {
  params: readonly binaryen.Type[];
  result: binaryen.Type;
  ctx: CodegenContext;
}): binaryen.Type => {
  return getFunctionRefType({ params, result, ctx, label: "closure" });
};

export const ensureClosureTypeInfo = ({
  typeId,
  desc,
  ctx,
  seen,
  mode,
  lowerType,
}: {
  typeId: TypeId;
  desc: {
    parameters: ReadonlyArray<{
      type: TypeId;
      label?: string;
      optional?: boolean;
    }>;
    returnType: TypeId;
    effectRow: unknown;
  };
  ctx: CodegenContext;
  seen: Set<TypeId>;
  mode: WasmTypeMode;
  lowerType: (
    typeId: TypeId,
    ctx: CodegenContext,
    seen: Set<TypeId>,
    mode: WasmTypeMode
  ) => binaryen.Type;
}): ClosureTypeInfo => {
  const key = closureSignatureKey({
    moduleId: ctx.moduleId,
    parameters: desc.parameters,
    returnType: desc.returnType,
    effectRow: desc.effectRow,
  });
  const cached = ctx.closureTypes.get(key);
  if (cached) {
    return cached;
  }

  const effectful =
    typeof desc.effectRow === "number" &&
    !ctx.program.effects.isEmpty(desc.effectRow);
  const handlerParamType = ctx.effectsRuntime.handlerFrameType;
  const userParamTypes = desc.parameters.map((param) =>
    lowerType(param.type, ctx, seen, mode)
  );
  const paramTypes = effectful
    ? [handlerParamType, ...userParamTypes]
    : userParamTypes;
  const resultType = effectful
    ? ctx.effectsRuntime.outcomeType
    : lowerType(desc.returnType, ctx, seen, mode);
  const interfaceType = defineStructType(ctx.mod, {
    name: closureStructName({ moduleLabel: ctx.moduleLabel, key }),
    fields: [{ name: "__fn", type: binaryen.funcref, mutable: false }],
    final: false,
  });
  const fnRefType = getClosureFunctionRefType({
    params: [interfaceType, ...paramTypes],
    result: resultType,
    ctx,
  });
  const info: ClosureTypeInfo = {
    key,
    typeId,
    interfaceType,
    fnRefType,
    paramTypes,
    resultType,
  };
  ctx.closureTypes.set(key, info);
  return info;
};

