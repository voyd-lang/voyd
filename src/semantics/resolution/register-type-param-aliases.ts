import { nop } from "../../syntax-objects/lib/helpers.js";
import { Identifier } from "../../syntax-objects/identifier.js";
import { TypeAlias } from "../../syntax-objects/types.js";
import type { ScopedEntity } from "../../syntax-objects/scoped-entity.js";
import type { Expr } from "../../syntax-objects/expr.js";

type TypeParamScope = (Expr & ScopedEntity) & {
  registerEntity: (alias: TypeAlias) => void;
  resolveEntity: (id: Identifier) => any;
};

export const registerTypeParamAliases = (
  scope: TypeParamScope,
  typeParams: Identifier[] | undefined
): void => {
  if (!typeParams?.length) return;

  typeParams.forEach((param) => {
    const existing = scope.resolveEntity(param);
    if (existing?.isTypeAlias?.()) {
      existing.setAttribute("is-type-param", true);
      return;
    }

    const alias = new TypeAlias({
      ...param.metadata,
      parent: scope,
      name: param.clone(),
      typeExpr: nop(),
    });

    alias.setAttribute("is-type-param", true);
    scope.registerEntity(alias);
  });
};

export default registerTypeParamAliases;
