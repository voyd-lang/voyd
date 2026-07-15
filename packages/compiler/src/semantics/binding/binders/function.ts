import type { Expr } from "../../../parser/index.js";
import {
  declarationDocForSyntax,
  parameterDocForSyntax,
  rememberSyntax,
} from "../context.js";
import { recordFunctionOverload } from "../overloads.js";
import type { TypeParameterDecl, ParameterDeclInput } from "../../decls.js";
import type { BindingContext } from "../types.js";
import type { ParsedFunctionDecl } from "../../../parser/surface/declarations.js";
import type { HirVisibility } from "../../hir/index.js";
import type { ScopeId } from "../../ids.js";
import { bindExpr, bindTypeExpr } from "./expressions.js";
import type { BinderScopeTracker } from "./scope-tracker.js";
import { bindTypeParameters } from "./type-parameters.js";
import { toSourceSpan } from "../../../parser/surface/utils.js";
import { declareValueOrParameter } from "../redefinitions.js";
import { getCompilerFunctionContractSpec } from "../../../compiler-contracts/index.js";

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
  options: BindFunctionOptions = {},
) => {
  const declarationScope = options.declarationScope ?? tracker.current();
  rememberSyntax(decl.form, ctx);
  const intrinsicMetadata = decl.intrinsic;
  const compilerFunctionContract = resolveCompilerFunctionContract({
    id: decl.compilerContract?.id,
    functionName: decl.signature.name.value,
    arity: decl.signature.params.length,
    declarationScope,
    ctx,
  });
  const boundaryMetadata = boundaryMetadataFromAttribute(
    decl.form.attributes?.boundary,
  );
  const symbolMetadata: Record<string, unknown> = {
    entity: "function",
    ...options.metadata,
    ...(boundaryMetadata ? { boundary: boundaryMetadata } : {}),
    ...(compilerFunctionContract ? { compilerFunctionContract } : {}),
    ...(compilerFunctionContract?.methodAlias
      ? { methodAlias: compilerFunctionContract.methodAlias }
      : {}),
    ...(compilerFunctionContract?.overloadPreference
      ? { overloadPreference: compilerFunctionContract.overloadPreference }
      : {}),
  };
  if (decl.signature.name.isQuoted) {
    symbolMetadata.quotedName = true;
  }

  if (intrinsicMetadata) {
    symbolMetadata.intrinsic = true;
    symbolMetadata.intrinsicName = intrinsicMetadata.name;
    symbolMetadata.intrinsicUsesSignature =
      intrinsicMetadata.usesSignature ?? false;
  }
  const external = decl.form.attributes?.external as { id: string } | undefined;
  if (external) {
    symbolMetadata.externalFunction = {
      interfaceId: external.id,
      functionName: decl.signature.name.value,
    };
  }

  const fnSymbol = ctx.symbolTable.declare(
    {
      name: decl.signature.name.value,
      kind: "value",
      declaredAt: decl.form.syntaxId,
      metadata: symbolMetadata,
    },
    declarationScope,
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
    boundParams.forEach((param) => bindTypeExpr(param.typeExpr, ctx, tracker));
    bindTypeExpr(decl.signature.returnType, ctx, tracker);
    bindTypeExpr(decl.signature.effectType, ctx, tracker);
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
    effectTypeExpr: decl.signature.effectType,
    body: decl.body,
    moduleIndex: options.moduleIndex ?? ctx.nextModuleIndex++,
    implId: undefined,
    intrinsic: intrinsicMetadata,
    documentation: declarationDocForSyntax(decl.signature.name, ctx),
  });

  recordFunctionOverload(fnDecl, declarationScope, ctx);
  return fnDecl;
};

const resolveCompilerFunctionContract = ({
  id,
  functionName,
  arity,
  declarationScope,
  ctx,
}: {
  id: string | undefined;
  functionName: string;
  arity: number;
  declarationScope: ScopeId;
  ctx: BindingContext;
}) => {
  if (!id) {
    return undefined;
  }
  if (declarationScope !== ctx.symbolTable.rootScope) {
    throw new Error(
      `@compiler_contract '${id}' on ${functionName} can only annotate an ordinary top-level function`,
    );
  }

  const spec = getCompilerFunctionContractSpec(id);
  if (!spec) {
    throw new Error(`unknown @compiler_contract id '${id}' on ${functionName}`);
  }
  if (!isAllowedContractProvider({ spec, ctx })) {
    const provider =
      spec.provider.namespace === "std"
        ? "the std namespace"
        : `package '${spec.provider.packageName}'`;
    throw new Error(
      `@compiler_contract '${id}' on ${functionName} is restricted to ${provider}`,
    );
  }
  if (arity !== spec.expectedArity) {
    throw new Error(
      `@compiler_contract '${id}' on ${functionName} expects ${spec.expectedArity} parameter(s), but the function declares ${arity}`,
    );
  }
  return { ...spec };
};

const isAllowedContractProvider = ({
  spec,
  ctx,
}: {
  spec: NonNullable<ReturnType<typeof getCompilerFunctionContractSpec>>;
  ctx: BindingContext;
}): boolean => {
  if (spec.provider.namespace === "std") {
    return ctx.module.path.namespace === "std";
  }
  if (ctx.module.path.namespace === "pkg") {
    return ctx.module.path.packageName === spec.provider.packageName;
  }
  return (
    ctx.module.path.namespace === "src" &&
    ctx.module.path.segments.length === 1 &&
    ctx.module.path.segments[0] === "html"
  );
};

const boundaryMetadataFromAttribute = (
  _value: unknown,
): unknown | undefined => {
  return undefined;
};

const bindFunctionTypeParameters = (
  decl: ParsedFunctionDecl,
  ctx: BindingContext,
): TypeParameterDecl[] =>
  bindTypeParameters(decl.signature.typeParameters, ctx);

const bindFunctionParameters = (
  decl: ParsedFunctionDecl,
  ctx: BindingContext,
  tracker: BinderScopeTracker,
  options: BindFunctionOptions = {},
) => {
  const boundParams: ParameterDeclInput[] = [];
  decl.signature.params.forEach((param, index) => {
    rememberSyntax(param.ast, ctx);
    if (param.labelAst) {
      rememberSyntax(param.labelAst, ctx);
    }
    const paramSymbol = declareValueOrParameter({
      name: param.name,
      kind: "parameter",
      declaredAt: param.ast.syntaxId,
      metadata: {
        bindingKind: param.bindingKind,
        declarationSpan: toSourceSpan(param.ast),
      },
      scope: tracker.current(),
      syntax: param.ast,
      ctx,
    });
    boundParams.push({
      name: param.name,
      label: param.label,
      labelAst: param.labelAst,
      optional: param.optional,
      defaultValue: param.defaultValue,
      symbol: paramSymbol,
      ast: param.ast,
      typeExpr:
        param.typeExpr ??
        (options.selfTypeExpr && index === 0 && param.name === "self"
          ? options.selfTypeExpr
          : undefined),
      bindingKind: param.bindingKind,
      documentation: parameterDocForSyntax(param.ast, ctx),
    });
  });

  decl.signature.params.forEach((param) =>
    bindExpr(param.defaultValue, ctx, tracker),
  );
  bindExpr(decl.body, ctx, tracker);

  return boundParams;
};
