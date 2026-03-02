import type { SymbolId, ScopeId } from "../ids.js";
import type { TypingContext } from "./types.js";

const importedTypeParameterScopes = new WeakMap<
  TypingContext["symbolTable"],
  ScopeId
>();

const importedTypeParameterScope = (
  ctx: Pick<TypingContext, "symbolTable" | "hir">
): ScopeId => {
  const existing = importedTypeParameterScopes.get(ctx.symbolTable);
  if (typeof existing === "number") {
    return existing;
  }
  const created = ctx.symbolTable.createScope({
    parent: ctx.symbolTable.rootScope,
    kind: "block",
    owner: ctx.hir.module.ast,
  });
  importedTypeParameterScopes.set(ctx.symbolTable, created);
  return created;
};

export const declareImportedTypeParameterSymbol = ({
  name,
  ctx,
}: {
  name: string;
  ctx: Pick<TypingContext, "symbolTable" | "hir">;
}): SymbolId =>
  ctx.symbolTable.declare(
    {
      name,
      kind: "type-parameter",
      declaredAt: ctx.hir.module.ast,
    },
    importedTypeParameterScope(ctx),
  );
