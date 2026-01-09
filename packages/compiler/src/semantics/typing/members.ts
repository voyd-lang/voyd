import type { TypeId } from "../ids.js";
import { getNominalComponent } from "./type-system.js";
import type { TypingContext } from "./types.js";
import { localSymbolForSymbolRef } from "./symbol-ref-utils.js";

const ownerSymbolFromType = (
  typeId: TypeId | undefined,
  ctx: TypingContext
): number | undefined => {
  if (typeof typeId !== "number") {
    return undefined;
  }
  const nominal = getNominalComponent(typeId, ctx);
  if (typeof nominal !== "number") {
    return undefined;
  }
  const desc = ctx.arena.get(nominal);
  if (desc.kind !== "nominal-object") {
    return undefined;
  }
  return localSymbolForSymbolRef(desc.owner, ctx);
};

export const indexMemberMetadata = (ctx: TypingContext): void => {
  ctx.hir.items.forEach((item) => {
    if (item.kind !== "function" || !item.memberVisibility) {
      return;
    }
    const existing = ctx.memberMetadata.get(item.symbol) ?? {};
    ctx.memberMetadata.set(item.symbol, {
      ...existing,
      visibility: item.memberVisibility,
      packageId: existing.packageId ?? ctx.packageId,
    });
  });

  ctx.hir.items.forEach((item) => {
    if (item.kind !== "impl") {
      return;
    }
    const owner = ownerSymbolFromType(
      item.target.typeId as TypeId | undefined,
      ctx
    );
    if (typeof owner !== "number") {
      return;
    }
    item.members.forEach((memberId) => {
      const member = ctx.hir.items.get(memberId);
      if (!member || member.kind !== "function") {
        return;
      }
      const existing = ctx.memberMetadata.get(member.symbol) ?? {};
      ctx.memberMetadata.set(member.symbol, {
        ...existing,
        owner,
        visibility: member.memberVisibility ?? existing.visibility,
        packageId: existing.packageId ?? ctx.packageId,
      });
    });
  });
};
