import { rememberSyntax } from "../context.js";
import { toSourceSpan } from "../../utils.js";
import type { BindingContext } from "../types.js";
import type { ParsedEffectDecl, ParsedEffectOperation } from "../parsing.js";
import type { BinderScopeTracker } from "./scope-tracker.js";
import type { TypeParameterDecl } from "../../decls.js";

const declareEffectOperationParams = ({
  op,
  ctx,
  scope,
}: {
  op: ParsedEffectOperation;
  ctx: BindingContext;
  scope: number;
}) =>
  op.params.map((param) => {
    const symbol = ctx.symbolTable.declare(
      {
        name: param.name,
        kind: "parameter",
        declaredAt: param.ast.syntaxId,
        metadata: {
          bindingKind: param.bindingKind,
          declarationSpan: toSourceSpan(param.ast),
        },
      },
      scope
    );
    rememberSyntax(param.ast, ctx);
    return {
      name: param.name,
      label: param.label,
      optional: param.optional,
      symbol,
      ast: param.ast,
      bindingKind: param.bindingKind,
      typeExpr: param.typeExpr,
    };
  });

export const bindEffectDecl = (
  decl: ParsedEffectDecl,
  ctx: BindingContext,
  tracker: BinderScopeTracker
): void => {
  rememberSyntax(decl.form, ctx);
  rememberSyntax(decl.name, ctx);
  const effectSymbol = ctx.symbolTable.declare(
    {
      name: decl.name.value,
      kind: "effect",
      declaredAt: decl.form.syntaxId,
      metadata: { entity: "effect" },
    },
    tracker.current()
  );

  const effectScope = ctx.symbolTable.createScope({
    parent: tracker.current(),
    kind: "module",
    owner: decl.form.syntaxId,
  });
  ctx.scopeByNode.set(decl.form.syntaxId, effectScope);

  const typeParameters: TypeParameterDecl[] = [];
  tracker.enterScope(effectScope, () => {
    decl.typeParameters.forEach((param) => {
      rememberSyntax(param, ctx);
      const symbol = ctx.symbolTable.declare({
        name: param.value,
        kind: "type-parameter",
        declaredAt: param.syntaxId,
      });
      typeParameters.push({ name: param.value, symbol, ast: param });
    });
  });

  const operations = decl.operations.map((op) => {
    rememberSyntax(op.form, ctx);
    const scope = ctx.symbolTable.createScope({
      parent: effectScope,
      kind: "function",
      owner: op.form.syntaxId,
    });
    ctx.scopeByNode.set(op.form.syntaxId, scope);
    const opSymbol = ctx.symbolTable.declare(
      {
        name: op.name.value,
        kind: "effect-op",
        declaredAt: op.form.syntaxId,
        metadata: { ownerEffect: effectSymbol, intrinsic: true },
      },
      tracker.current()
    );

    let params: ReturnType<typeof declareEffectOperationParams> = [];
    tracker.enterScope(scope, () => {
      params = declareEffectOperationParams({ op, ctx, scope });
    });

    const moduleMembers =
      ctx.moduleMembers.get(effectSymbol) ??
      new Map<string, Set<number>>();
    const bucket = moduleMembers.get(op.name.value) ?? new Set<number>();
    bucket.add(opSymbol);
    moduleMembers.set(op.name.value, bucket);
    ctx.moduleMembers.set(effectSymbol, moduleMembers);

    return {
      name: op.name.value,
      symbol: opSymbol,
      ast: op.form,
      parameters: params,
      resumable: op.resumable,
      returnTypeExpr: op.returnType,
    };
  });

  ctx.decls.registerEffect({
    name: decl.name.value,
    form: decl.form,
    visibility: decl.visibility,
    symbol: effectSymbol,
    effectId: decl.effectId,
    typeParameters,
    operations,
    moduleIndex: ctx.nextModuleIndex++,
    scope: effectScope,
  });
};
