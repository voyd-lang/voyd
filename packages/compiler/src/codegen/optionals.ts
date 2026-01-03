import binaryen from "binaryen";
import { initStruct } from "@voyd/lib/binaryen-gc/index.js";
import type { CodegenContext, FunctionContext, TypeId } from "./context.js";
import { coerceValueToType } from "./structural.js";
import { getStructuralTypeInfo } from "./types.js";

const nominalNameOf = (typeId: TypeId, ctx: CodegenContext): string | undefined => {
  const desc = ctx.typing.arena.get(typeId);
  if (desc.kind === "nominal-object") {
    return desc.name ?? ctx.symbolTable.getSymbol(desc.owner).name;
  }
  if (desc.kind === "intersection" && typeof desc.nominal === "number") {
    const nominalDesc = ctx.typing.arena.get(desc.nominal);
    if (nominalDesc.kind === "nominal-object") {
      return nominalDesc.name ?? ctx.symbolTable.getSymbol(nominalDesc.owner).name;
    }
  }
  return undefined;
};

export const optionalUnionMemberTypeId = ({
  unionTypeId,
  memberName,
  ctx,
}: {
  unionTypeId: TypeId;
  memberName: string;
  ctx: CodegenContext;
}): TypeId | undefined => {
  const desc = ctx.typing.arena.get(unionTypeId);
  if (desc.kind !== "union") {
    return undefined;
  }
  return desc.members.find((member) => nominalNameOf(member, ctx) === memberName);
};

export const compileOptionalNoneValue = ({
  targetTypeId,
  ctx,
  fnCtx,
}: {
  targetTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const noneTypeId = optionalUnionMemberTypeId({
    unionTypeId: targetTypeId,
    memberName: "None",
    ctx,
  });
  if (typeof noneTypeId !== "number") {
    throw new Error("optional default requires a union with None");
  }

  const noneInfo = getStructuralTypeInfo(noneTypeId, ctx);
  if (!noneInfo) {
    throw new Error("optional default requires structural type info for None");
  }
  if (noneInfo.fields.length > 0) {
    throw new Error("optional default None type must not declare fields");
  }

  const noneValue = initStruct(ctx.mod, noneInfo.runtimeType, [
    ctx.mod.global.get(
      noneInfo.ancestorsGlobal,
      ctx.rtt.extensionHelpers.i32Array
    ),
    ctx.mod.global.get(
      noneInfo.fieldTableGlobal,
      ctx.rtt.fieldLookupHelpers.lookupTableType
    ),
    ctx.mod.global.get(
      noneInfo.methodTableGlobal,
      ctx.rtt.methodLookupHelpers.lookupTableType
    ),
  ]);
  return coerceValueToType({
    value: noneValue,
    actualType: noneTypeId,
    targetType: targetTypeId,
    ctx,
    fnCtx,
  });
};
