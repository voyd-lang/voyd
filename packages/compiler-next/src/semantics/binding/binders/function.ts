import type { Expr } from "../../../parser/index.js";
import { rememberSyntax } from "../context.js";
import { recordFunctionOverload } from "../overloads.js";
import type { TypeParameterDecl, ParameterDeclInput } from "../../decls.js";
import type { BindingContext } from "../types.js";
import type { ParsedFunctionDecl } from "../parsing.js";
import type { HirVisibility } from "../../hir/index.js";
import type { ScopeId, SymbolId } from "../../ids.js";
import { bindExpr } from "./expressions.js";
import type { BinderScopeTracker } from "./scope-tracker.js";
import { bindTypeParameters } from "./type-parameters.js";
import { toSourceSpan } from "../../utils.js";

export type BindFunctionOptions = {
  declarationScope?: ScopeId;
  scopeParent?: ScopeId;
  metadata?: Record<string, unknown>;
  moduleIndex?: number;
  selfTypeExpr?: Expr;
  visibilityOverride?: HirVisibility;
  memberVisibility?: HirVisibility;
};

export const bindFunctionDecl = (
  decl: ParsedFunctionDecl,
  ctx: BindingContext,
  tracker: BinderScopeTracker,
  options: BindFunctionOptions = {}
) => {
  const declarationScope = options.declarationScope ?? tracker.current();
  rememberSyntax(decl.form, ctx);
  const intrinsicMetadata = decl.intrinsic;
  const symbolMetadata: Record<string, unknown> = {
    entity: "function",
    ...options.metadata,
  };

  if (intrinsicMetadata) {
    symbolMetadata.intrinsic = true;
    symbolMetadata.intrinsicName = intrinsicMetadata.name;
    symbolMetadata.intrinsicUsesSignature = intrinsicMetadata.usesSignature ?? false;
  }

  const fnSymbol = ctx.symbolTable.declare(
    {
      name: decl.signature.name.value,
      kind: "value",
      declaredAt: decl.form.syntaxId,
      metadata: symbolMetadata,
    },
    declarationScope
  );

  const fnScope = ctx.symbolTable.createScope({
    parent: options.scopeParent ?? tracker.current(),
    kind: "function",
    owner: decl.form.syntaxId,
  });
  ctx.scopeByNode.set(decl.form.syntaxId, fnScope);

  let typeParameters: TypeParameterDecl[] = [];
  let boundParams: ParameterDeclInput[] = [];
  tracker.enterScope(fnScope, () => {
    typeParameters = bindFunctionTypeParameters(decl, ctx);
    boundParams = bindFunctionParameters(decl, ctx, tracker, options);
  });

  const visibility = options.visibilityOverride ?? decl.visibility;
  const fnDecl = ctx.decls.registerFunction({
    name: decl.signature.name.value,
    form: decl.form,
    visibility,
    symbol: fnSymbol,
    scope: fnScope,
    memberVisibility: options.memberVisibility,
    params: boundParams,
    typeParameters,
    returnTypeExpr: decl.signature.returnType,
    body: decl.body,
    moduleIndex: options.moduleIndex ?? ctx.nextModuleIndex++,
    implId: undefined,
    intrinsic: intrinsicMetadata,
  });

  recordFunctionOverload(fnDecl, declarationScope, ctx);
  return fnDecl;
};

const bindFunctionTypeParameters = (
  decl: ParsedFunctionDecl,
  ctx: BindingContext
): TypeParameterDecl[] =>
  bindTypeParameters(decl.signature.typeParameters, ctx);

const bindFunctionParameters = (
  decl: ParsedFunctionDecl,
  ctx: BindingContext,
  tracker: BinderScopeTracker,
  options: BindFunctionOptions = {}
) => {
  const boundParams: ParameterDeclInput[] = [];
  decl.signature.params.forEach((param, index) => {
    const paramSymbol = ctx.symbolTable.declare({
      name: param.name,
      kind: "parameter",
      declaredAt: param.ast.syntaxId,
      metadata: {
        bindingKind: param.bindingKind,
        declarationSpan: toSourceSpan(param.ast),
      },
    });
    rememberSyntax(param.ast, ctx);
    boundParams.push({
      name: param.name,
      label: param.label,
      symbol: paramSymbol,
      ast: param.ast,
      typeExpr:
        param.typeExpr ??
        (options.selfTypeExpr && index === 0 && param.name === "self"
          ? options.selfTypeExpr
          : undefined),
      bindingKind: param.bindingKind,
    });
  });

  bindExpr(decl.body, ctx, tracker);

  return boundParams;
};
