import binaryen from "binaryen";
import { defineStructType } from "@voyd-lang/lib/binaryen-gc/index.js";
import type { AugmentedBinaryen } from "@voyd-lang/lib/binaryen-gc/types.js";
import type { ClosureTypeInfo, CodegenContext, TypeId } from "./context.js";
import { getAbiTypesForSignature, getSignatureWasmType } from "./types.js";

const bin = binaryen as unknown as AugmentedBinaryen;

const sanitizeIdentifier = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");

const expandAbiTypes = (type: binaryen.Type): binaryen.Type[] =>
  type === binaryen.none ? [] : [...binaryen.expandType(type)];

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
  parameters,
  returnType,
  effectRow,
  mode,
}: {
  parameters: ReadonlyArray<{
    type: TypeId;
    label?: string;
    optional?: boolean;
  }>;
  returnType: TypeId;
  effectRow: unknown;
  mode: WasmTypeMode;
}): string => {
  const params = parameters
    .map((param) => {
      const label = param.label ?? "_";
      const optional = param.optional ? "?" : "";
      return `${label}:${param.type}${optional}`;
    })
    .join("|");
  return `${mode}::(${params})->${returnType}|${effectRow}`;
};

const closureStructName = ({
  key,
}: {
  key: string;
}): string => `voyd__closure_base_${sanitizeIdentifier(key)}`;

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
    parameters: desc.parameters,
    returnType: desc.returnType,
    effectRow: desc.effectRow,
    mode,
  });
  const cached = ctx.closureTypes.get(key);
  if (cached) {
    return cached;
  }

  const effectful =
    typeof desc.effectRow === "number" &&
    !ctx.program.effects.isEmpty(desc.effectRow);
  const paramAbiTypes = desc.parameters.map((param) =>
    mode === "signature"
      ? getAbiTypesForSignature(param.type, ctx)
      : expandAbiTypes(lowerType(param.type, ctx, seen, mode)),
  );
  const userParamTypes = paramAbiTypes.flat();
  const resultAbiTypes =
    mode === "signature"
      ? getAbiTypesForSignature(desc.returnType, ctx)
      : expandAbiTypes(lowerType(desc.returnType, ctx, seen, mode));
  const widened = ctx.effectsBackend.abi.widenSignature({
    ctx,
    effectful,
    userParamTypes,
    userResultType:
      mode === "signature"
        ? getSignatureWasmType(desc.returnType, ctx)
        : lowerType(desc.returnType, ctx, seen, mode),
  });
  const paramTypes = widened.paramTypes;
  const resultType = widened.resultType;
  const interfaceType = defineStructType(ctx.mod, {
    name: closureStructName({ key }),
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
    paramAbiTypes,
    userParamOffset: widened.userParamOffset,
    resultType,
    resultAbiTypes,
  };
  ctx.closureTypes.set(key, info);
  return info;
};
