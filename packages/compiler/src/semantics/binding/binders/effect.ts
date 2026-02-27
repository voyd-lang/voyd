import { declarationDocForSyntax, rememberSyntax } from "../context.js";
import { toSourceSpan } from "../../utils.js";
import type { BindingContext } from "../types.js";
import type { ParsedEffectDecl, ParsedEffectOperation } from "../parsing.js";
import type { BinderScopeTracker } from "./scope-tracker.js";
import type { TypeParameterDecl } from "../../decls.js";
import { declareValueOrParameter } from "../redefinitions.js";
import { reportOverloadNameCollision } from "../name-collisions.js";
import { bindTypeParameters } from "./type-parameters.js";
import { reportInvalidTypeDeclarationName } from "../type-name-convention.js";

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
    rememberSyntax(param.ast, ctx);
    if (param.labelAst) {
      rememberSyntax(param.labelAst, ctx);
    }
    const symbol = declareValueOrParameter({
      name: param.name,
      kind: "parameter",
      declaredAt: param.ast.syntaxId,
      metadata: {
        bindingKind: param.bindingKind,
        declarationSpan: toSourceSpan(param.ast),
      },
      scope,
      syntax: param.ast,
      ctx,
    });
    return {
      name: param.name,
      label: param.label,
      labelAst: param.labelAst,
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
  reportInvalidTypeDeclarationName({
    declarationKind: "effect",
    name: decl.name,
    ctx,
  });
  reportOverloadNameCollision({
    name: decl.name.value,
    scope: tracker.current(),
    syntax: decl.name,
    ctx,
  });
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
    typeParameters.push(...bindTypeParameters(decl.typeParameters, ctx));
  });

  const operations = decl.operations.map((op) => {
    rememberSyntax(op.form, ctx);
    rememberSyntax(op.name, ctx);
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
      documentation: declarationDocForSyntax(op.name, ctx),
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
    documentation: declarationDocForSyntax(decl.name, ctx),
  });
};
