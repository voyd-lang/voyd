import type { SymbolTable } from "../binder/index.js";
import type { SymbolId, TypeId } from "../ids.js";
import type { TypingResult } from "../typing/index.js";
import type { SymbolRef } from "../typing/symbol-ref.js";

export const typeHasIntrinsicRole = ({
  type,
  role,
  typing,
  symbolTable,
  moduleId,
  imports,
}: {
  type: TypeId | undefined;
  role: string;
  typing: TypingResult;
  symbolTable: SymbolTable;
  moduleId: string;
  imports: ReadonlyMap<SymbolId, SymbolRef>;
}): boolean => {
  if (typeof type !== "number") return false;
  const nominal = typing.arena.nominalComponent(type);
  if (typeof nominal !== "number") return false;
  const registered = typing.intrinsicTypes.get(role);
  const registeredNominal =
    typeof registered === "number"
      ? (typing.arena.nominalComponent(registered) ?? registered)
      : undefined;
  if (registeredNominal === nominal) return true;
  const descriptor = typing.arena.get(typing.arena.unfoldRecursive(nominal));
  if (
    descriptor.kind !== "nominal-object" &&
    descriptor.kind !== "value-object"
  ) {
    return false;
  }
  const ownerSymbol =
    descriptor.owner.moduleId === moduleId
      ? descriptor.owner.symbol
      : Array.from(imports).find(
          ([, target]) =>
            target.moduleId === descriptor.owner.moduleId &&
            target.symbol === descriptor.owner.symbol,
        )?.[0];
  if (ownerSymbol === undefined || !symbolTable.hasSymbol(ownerSymbol)) {
    return false;
  }
  const metadata = symbolTable.getSymbol(ownerSymbol).metadata as
    | { intrinsicType?: unknown }
    | undefined;
  return metadata?.intrinsicType === role;
};

/** Matches one exact nominal declaration, including its defining module. */
export const typeHasNominalIdentity = ({
  type,
  ownerModuleId,
  ownerName,
  typing,
}: {
  type: TypeId | undefined;
  ownerModuleId: string;
  ownerName: string;
  typing: TypingResult;
}): boolean => {
  if (typeof type !== "number") return false;
  const nominal = typing.arena.nominalComponent(type);
  if (typeof nominal !== "number") return false;
  const descriptor = typing.arena.get(typing.arena.unfoldRecursive(nominal));
  return (
    (descriptor.kind === "nominal-object" ||
      descriptor.kind === "value-object") &&
    descriptor.owner.moduleId === ownerModuleId &&
    descriptor.name === ownerName
  );
};
