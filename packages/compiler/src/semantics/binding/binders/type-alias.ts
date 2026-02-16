import type { ParsedTypeAliasDecl } from "../parsing.js";
import type { BindingContext } from "../types.js";
import type { TypeParameterDecl } from "../../decls.js";
import { rememberSyntax } from "../context.js";
import { bindTypeParameters } from "./type-parameters.js";
import type { BinderScopeTracker } from "./scope-tracker.js";
import { reportOverloadNameCollision } from "../name-collisions.js";

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
  reportOverloadNameCollision({
    name: decl.name.value,
    scope: tracker.current(),
    syntax: decl.name,
    ctx,
  });

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

  let typeParameters: TypeParameterDecl[] = [];
  tracker.enterScope(aliasScope, () => {
    typeParameters = bindTypeParameters(decl.typeParameters, ctx);
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
