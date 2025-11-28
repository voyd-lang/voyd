import { type Expr, isIdentifierAtom, isForm } from "../../../parser/index.js";
import { rememberSyntax } from "../context.js";
import type { TypeParameterDecl, TraitDecl } from "../decls.js";
import type { BindingContext } from "../types.js";
import type { ParsedImplDecl } from "../parsing.js";
import { parseFunctionDecl } from "../parsing.js";
import type { ScopeId } from "../../ids.js";
import { bindFunctionDecl } from "./function.js";
import {
  makeParsedFunctionFromTraitMethod,
  resolveTraitDecl,
  extractTraitTypeArguments,
} from "./trait.js";
import { resolveObjectDecl } from "./object.js";
import type { BinderScopeTracker } from "./scope-tracker.js";

export const bindImplDecl = (
  decl: ParsedImplDecl,
  ctx: BindingContext,
  tracker: BinderScopeTracker
): void => {
  rememberSyntax(decl.form, ctx);
  rememberSyntax(decl.target, ctx);
  rememberSyntax(decl.trait, ctx);
  rememberSyntax(decl.body, ctx);

  const implName = isIdentifierAtom(decl.target)
    ? `${decl.target.value}::impl`
    : `impl#${decl.form.syntaxId}`;

  const implSymbol = ctx.symbolTable.declare(
    {
      name: implName,
      kind: "impl",
      declaredAt: decl.form.syntaxId,
      metadata: { entity: "impl" },
    },
    tracker.current()
  );

  const implScope = ctx.symbolTable.createScope({
    parent: tracker.current(),
    kind: "impl",
    owner: decl.form.syntaxId,
  });
  ctx.scopeByNode.set(decl.form.syntaxId, implScope);
  ctx.scopeByNode.set(decl.body.syntaxId, implScope);

  const typeParameters: TypeParameterDecl[] = [];
  const methods: ReturnType<typeof bindFunctionDecl>[] = [];
  const inferredTypeParams = inferImplTypeParameters({
    target: decl.target,
    trait: decl.trait,
    ctx,
    scope: implScope,
  });
  tracker.enterScope(implScope, () => {
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

    inferredTypeParams.forEach((name) => {
      if (typeParameters.some((param) => param.name === name)) {
        return;
      }
      const paramSymbol = ctx.symbolTable.declare({
        name,
        kind: "type-parameter",
        declaredAt: decl.form?.syntaxId ?? decl.target.syntaxId,
      });
      typeParameters.push({ name, symbol: paramSymbol });
    });

    decl.body.rest.forEach((entry) => {
      if (!isForm(entry)) {
        return;
      }
      const parsedFn = parseFunctionDecl(entry);
      if (!parsedFn) {
        throw new Error("impl body supports only function declarations");
      }
      const method = bindFunctionDecl(parsedFn, ctx, tracker, {
        declarationScope: ctx.symbolTable.rootScope,
        scopeParent: implScope,
        metadata: { entity: "function", impl: implSymbol },
        selfTypeExpr: decl.target,
      });
      methods.push(method);
    });

    if (decl.trait) {
      const traitDecl = resolveTraitDecl(decl.trait, ctx, tracker.current());
      if (traitDecl) {
        const traitTypeParamMap = buildTraitTypeParamMap(traitDecl, decl.trait);
        const methodNames = new Set(
          methods.map((method) => ctx.symbolTable.getSymbol(method.symbol).name)
        );
        traitDecl.methods.forEach((traitMethod) => {
          if (!traitMethod.defaultBody) {
            return;
          }
          const name = ctx.symbolTable.getSymbol(traitMethod.symbol).name;
          if (methodNames.has(name)) {
            return;
          }
          const parsed = makeParsedFunctionFromTraitMethod(traitMethod, {
            typeParamSubstitutions: traitTypeParamMap,
          });
          const method = bindFunctionDecl(parsed, ctx, tracker, {
            declarationScope: ctx.symbolTable.rootScope,
            scopeParent: implScope,
            metadata: { entity: "function", impl: implSymbol },
            selfTypeExpr: decl.target,
          });
          methods.push(method);
        });
      }
    }
  });

  const implDecl = ctx.decls.registerImpl({
    form: decl.form,
    visibility: decl.visibility,
    symbol: implSymbol,
    target: decl.target,
    trait: decl.trait,
    typeParameters,
    methods,
    scope: implScope,
    moduleIndex: ctx.nextModuleIndex++,
  });

  methods.forEach((method) => {
    method.implId = implDecl.id;
  });
};

const inferImplTypeParameters = ({
  target,
  trait,
  ctx,
  scope,
}: {
  target: Expr;
  trait?: Expr;
  ctx: BindingContext;
  scope: ScopeId;
}): string[] => {
  const inferred = new Set<string>();

  const targetDecl = resolveObjectDecl(target, ctx, scope);
  if (targetDecl?.typeParameters?.length) {
    const args = extractTraitTypeArguments(target);
    if (args.length === targetDecl.typeParameters.length) {
      targetDecl.typeParameters.forEach((param, index) => {
        const arg = args[index];
        if (isIdentifierAtom(arg) && arg.value === param.name) {
          inferred.add(param.name);
        }
      });
    }
  }

  const traitDecl = trait ? resolveTraitDecl(trait, ctx, scope) : undefined;
  if (traitDecl?.typeParameters?.length) {
    const args = trait ? extractTraitTypeArguments(trait) : [];
    if (args.length === traitDecl.typeParameters.length) {
      traitDecl.typeParameters.forEach((param, index) => {
        const arg = args[index];
        if (isIdentifierAtom(arg) && arg.value === param.name) {
          inferred.add(param.name);
        }
      });
    }
  }

  return Array.from(inferred);
};

const buildTraitTypeParamMap = (
  traitDecl: TraitDecl,
  traitExpr: Expr
): Map<string, Expr> | undefined => {
  const params = traitDecl.typeParameters ?? [];
  if (params.length === 0) {
    return undefined;
  }
  const args = extractTraitTypeArguments(traitExpr);
  if (args.length === 0) {
    return undefined;
  }

  const substitutions = new Map<string, Expr>();
  params.forEach((param, index) => {
    const arg = args[index];
    if (arg) {
      substitutions.set(param.name, arg);
    }
  });
  return substitutions.size > 0 ? substitutions : undefined;
};
