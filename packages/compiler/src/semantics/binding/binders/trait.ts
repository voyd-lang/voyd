import {
  type Expr,
  type IdentifierAtom,
  type Syntax,
  isForm,
  isIdentifierAtom,
  formCallsInternal,
} from "../../../parser/index.js";
import type { IntrinsicAttribute } from "../../../parser/attributes.js";
import { rememberSyntax } from "../context.js";
import type {
  TraitMethodDeclInput,
  TypeParameterDecl,
  TraitMethodDecl,
  TraitDecl,
  ParameterDeclInput,
} from "../../decls.js";
import type { ScopeId, SymbolId } from "../../ids.js";
import type { BindingContext } from "../types.js";
import {
  normalizeIntrinsicAttribute,
  type ParsedTraitDecl,
  type ParsedTraitMethod,
  type ParsedFunctionDecl,
} from "../parsing.js";
import type { BinderScopeTracker } from "./scope-tracker.js";
import { bindExpr } from "./expressions.js";
import { bindTypeParameters } from "./type-parameters.js";
import { toSourceSpan } from "../../utils.js";
import { moduleVisibility } from "../../hir/index.js";
import { declareValueOrParameter } from "../redefinitions.js";

export const bindTraitDecl = (
  decl: ParsedTraitDecl,
  ctx: BindingContext,
  tracker: BinderScopeTracker
): void => {
  rememberSyntax(decl.form, ctx);
  rememberSyntax(decl.name, ctx);
  rememberSyntax(decl.body, ctx);

  const symbol = ctx.symbolTable.declare({
    name: decl.name.value,
    kind: "trait",
    declaredAt: decl.form.syntaxId,
    metadata: { entity: "trait" },
  });

  const traitScope = ctx.symbolTable.createScope({
    parent: tracker.current(),
    kind: "trait",
    owner: decl.form.syntaxId,
  });
  ctx.scopeByNode.set(decl.form.syntaxId, traitScope);
  ctx.scopeByNode.set(decl.body.syntaxId, traitScope);

  let typeParameters: TypeParameterDecl[] = [];
  const methods: TraitMethodDeclInput[] = [];

  tracker.enterScope(traitScope, () => {
    typeParameters = bindTypeParameters(decl.typeParameters, ctx);

    decl.methods.forEach((method) => {
      methods.push(
        bindTraitMethod({
          decl: method,
          ctx,
          tracker,
          traitScope,
          traitSymbol: symbol,
        })
      );
    });
  });

  ctx.decls.registerTrait({
    name: decl.name.value,
    form: decl.form,
    visibility: decl.visibility,
    symbol,
    typeParameters,
    methods,
    scope: traitScope,
    moduleIndex: ctx.nextModuleIndex++,
  });
};

const bindTraitMethod = ({
  decl,
  ctx,
  tracker,
  traitScope,
  traitSymbol,
}: {
  decl: ParsedTraitMethod;
  ctx: BindingContext;
  tracker: BinderScopeTracker;
  traitScope: ScopeId;
  traitSymbol: SymbolId;
}): TraitMethodDeclInput => {
  rememberSyntax(decl.form, ctx);
  rememberSyntax(decl.body, ctx);

  const intrinsicMetadata = decl.intrinsic;
  const methodMetadata: Record<string, unknown> = {
    entity: "trait-method",
    trait: traitSymbol,
  };

  if (intrinsicMetadata) {
    methodMetadata.intrinsic = true;
    methodMetadata.intrinsicName = intrinsicMetadata.name;
    methodMetadata.intrinsicUsesSignature =
      intrinsicMetadata.usesSignature ?? false;
  }

  const methodSymbol = ctx.symbolTable.declare(
    {
      name: decl.signature.name.value,
      kind: "value",
      declaredAt: decl.form.syntaxId,
      metadata: methodMetadata,
    },
    traitScope
  );

  const methodScope = ctx.symbolTable.createScope({
    parent: traitScope,
    kind: "function",
    owner: decl.form.syntaxId,
  });
  ctx.scopeByNode.set(decl.form.syntaxId, methodScope);

  let typeParameters: TypeParameterDecl[] = [];
  let params: ParameterDeclInput[] = [];
  tracker.enterScope(methodScope, () => {
    typeParameters = bindTypeParameters(decl.signature.typeParameters, ctx);
    params = bindTraitMethodParameters(decl, ctx, methodScope);
    bindExpr(decl.body, ctx, tracker);
  });

  return {
    name: decl.signature.name.value,
    form: decl.form,
    symbol: methodSymbol,
    scope: methodScope,
    nameAst: decl.signature.name,
    params,
    typeParameters,
    returnTypeExpr: decl.signature.returnType,
    effectTypeExpr: decl.signature.effectType,
    defaultBody: decl.body,
    intrinsic: decl.intrinsic,
  };
};

const bindTraitMethodParameters = (
  decl: ParsedTraitMethod,
  ctx: BindingContext,
  scope: ScopeId
): ParameterDeclInput[] =>
  decl.signature.params.map((param) => {
    rememberSyntax(param.ast, ctx);
    if (param.labelAst) {
      rememberSyntax(param.labelAst, ctx);
    }
    rememberSyntax(param.typeExpr as Syntax, ctx);
    const paramSymbol = declareValueOrParameter({
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
      symbol: paramSymbol,
      ast: param.ast,
      typeExpr: param.typeExpr,
      bindingKind: param.bindingKind,
    };
  });

export const resolveTraitDecl = (
  traitExpr: Expr,
  ctx: BindingContext,
  scope: ScopeId
) => {
  const traitIdentifier = (() => {
    if (isIdentifierAtom(traitExpr)) {
      return traitExpr;
    }
    if (!isForm(traitExpr)) {
      return undefined;
    }
    if (isIdentifierAtom(traitExpr.first)) {
      return traitExpr.first;
    }
    if (traitExpr.callsInternal("generics")) {
      const target = traitExpr.at(1);
      if (isIdentifierAtom(target)) {
        return target;
      }
      if (isForm(target) && isIdentifierAtom(target.first)) {
        return target.first;
      }
    }
    return undefined;
  })();
  if (!traitIdentifier) {
    return undefined;
  }
  const traitSymbol = ctx.symbolTable.resolve(traitIdentifier.value, scope);
  if (typeof traitSymbol !== "number") {
    return undefined;
  }
  const record = ctx.symbolTable.getSymbol(traitSymbol);
  if (record.kind !== "trait") {
    return undefined;
  }
  return ctx.decls.getTrait(record.id);
};

export const makeParsedFunctionFromTraitMethod = (
  method: TraitMethodDecl,
  options?: { typeParamSubstitutions?: Map<string, Expr> }
): ParsedFunctionDecl => {
  const nameAst = method.nameAst?.clone();
  if (!nameAst) {
    throw new Error("trait method missing name identifier");
  }

  const clonedDefaultBody = method.defaultBody?.clone();
  const form =
    method.form?.clone() ??
    (isForm(clonedDefaultBody) ? clonedDefaultBody : undefined);
  if (!form) {
    throw new Error("trait method default implementation missing form");
  }

  const signatureParams = method.params.map((param) => {
    if (!param.ast) {
      throw new Error("trait method parameter missing syntax");
    }
    const clonedAst = param.ast.clone();
    const clonedLabelAst =
      param.labelAst?.syntaxId === param.ast.syntaxId
        ? clonedAst
        : param.labelAst?.clone();
    const typeExpr = substituteTypeParamExpr(
      param.typeExpr?.clone(),
      options?.typeParamSubstitutions
    );
    return {
      name: param.name,
      label: param.label,
      labelAst: clonedLabelAst,
      optional: param.optional,
      ast: clonedAst,
      typeExpr,
    };
  });

  const returnType = substituteTypeParamExpr(
    method.returnTypeExpr?.clone(),
    options?.typeParamSubstitutions
  );

  return {
    form,
    visibility: moduleVisibility(),
    signature: {
      name: nameAst,
      typeParameters:
        method.typeParameters
          ?.map((param) => param.ast)
          .filter((entry): entry is IdentifierAtom => Boolean(entry)) ?? [],
      params: signatureParams,
      returnType,
    },
    body: clonedDefaultBody ?? form,
    intrinsic: normalizeIntrinsicAttribute(
      (form.attributes?.intrinsic as IntrinsicAttribute | undefined) ??
        method.intrinsic,
      nameAst.value
    ),
  };
};

const substituteTypeParamExpr = (
  expr: Expr | undefined,
  substitutions?: Map<string, Expr>
): Expr | undefined => {
  if (!expr || !substitutions || substitutions.size === 0) {
    return expr;
  }

  if (isIdentifierAtom(expr)) {
    return substitutions.get(expr.value) ?? expr;
  }
  return expr;
};

export const extractTraitTypeArguments = (traitExpr: Expr): readonly Expr[] => {
  if (isForm(traitExpr) && isIdentifierAtom(traitExpr.first)) {
    if (
      isForm(traitExpr.second) &&
      formCallsInternal(traitExpr.second, "generics")
    ) {
      return traitExpr.second.rest;
    }
    return [];
  }

  if (isForm(traitExpr) && formCallsInternal(traitExpr, "generics")) {
    return traitExpr.rest;
  }

  return [];
};
