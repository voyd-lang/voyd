import { toSourceSpan } from "../../utils.js";
import { declarationDocForSyntax, rememberSyntax } from "../context.js";
import { bindExpr } from "./expressions.js";
import type { ParsedModuleLetDecl } from "../parsing.js";
import type { BindingContext } from "../types.js";
import type { BinderScopeTracker } from "./scope-tracker.js";
import { declareValueOrParameter } from "../redefinitions.js";

export const bindModuleLetDecl = (
  decl: ParsedModuleLetDecl,
  ctx: BindingContext,
  tracker: BinderScopeTracker,
): void => {
  const scope = tracker.current();
  rememberSyntax(decl.form, ctx);
  rememberSyntax(decl.name, ctx);
  if (decl.typeExpr) {
    rememberSyntax(decl.typeExpr, ctx);
  }

  const symbol = declareValueOrParameter({
    name: decl.name.value,
    kind: "value",
    declaredAt: decl.form.syntaxId,
    metadata: {
      declarationSpan: toSourceSpan(decl.name),
      mutable: false,
      bindingKind: "value",
      moduleLet: true,
    },
    scope,
    syntax: decl.name,
    ctx,
  });

  ctx.scopeByNode.set(decl.form.syntaxId, scope);
  ctx.decls.registerModuleLet({
    name: decl.name.value,
    form: decl.form,
    visibility: decl.visibility,
    symbol,
    initializer: decl.initializer,
    typeExpr: decl.typeExpr,
    moduleIndex: ctx.nextModuleIndex++,
    documentation: declarationDocForSyntax(decl.name, ctx),
  });

  bindExpr(decl.initializer, ctx, tracker);
};
