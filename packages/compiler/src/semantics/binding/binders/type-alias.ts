import type { ParsedTypeAliasDecl } from "../parsing.js";
import type { BindingContext } from "../types.js";
import type { TypeParameterDecl } from "../../decls.js";
import { rememberSyntax } from "../context.js";
import { bindTypeParameters } from "./type-parameters.js";
import type { BinderScopeTracker } from "./scope-tracker.js";

export const bindTypeAlias = (
  decl: ParsedTypeAliasDecl,
  ctx: BindingContext,
  tracker: BinderScopeTracker
): void => {
  rememberSyntax(decl.form, ctx);
  rememberSyntax(decl.name, ctx);
  rememberSyntax(decl.target, ctx);

  const intrinsicType = decl.form.attributes?.intrinsicType;
  const intrinsicTypeMetadata =
    typeof intrinsicType === "string" ? { intrinsicType } : undefined;

  const symbol = ctx.symbolTable.declare({
    name: decl.name.value,
    kind: "type",
    declaredAt: decl.form.syntaxId,
    metadata: { entity: "type-alias", ...intrinsicTypeMetadata },
  });

  const aliasScope = ctx.symbolTable.createScope({
    parent: tracker.current(),
    kind: "module",
    owner: decl.form.syntaxId,
  });
  ctx.scopeByNode.set(decl.form.syntaxId, aliasScope);

  const typeParameters: TypeParameterDecl[] = [];
  tracker.enterScope(aliasScope, () => {
    decl.typeParameters.forEach((param) => {
      rememberSyntax(param, ctx);
      const paramSymbol = ctx.symbolTable.declare({
        name: param.value,
        kind: "type-parameter",
        declaredAt: param.syntaxId,
      });
      typeParameters.push({
        name: param.value,
        symbol: paramSymbol,
        ast: param,
      });
    });
  });

  ctx.decls.registerTypeAlias({
    name: decl.name.value,
    form: decl.form,
    visibility: decl.visibility,
    symbol,
    target: decl.target,
    typeParameters,
    moduleIndex: ctx.nextModuleIndex++,
  });
};
