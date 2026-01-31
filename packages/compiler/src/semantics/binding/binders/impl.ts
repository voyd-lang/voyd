import { type Expr, isIdentifierAtom, isForm } from "../../../parser/index.js";
import { rememberSyntax } from "../context.js";
import type { TypeParameterDecl, TraitDecl } from "../../decls.js";
import type { BindingContext } from "../types.js";
import type { ParsedFunctionDecl, ParsedImplDecl } from "../parsing.js";
import { parseFunctionDecl } from "../parsing.js";
import type { ScopeId, SymbolId } from "../../ids.js";
import { bindFunctionDecl } from "./function.js";
import {
  makeParsedFunctionFromTraitMethod,
  resolveTraitDecl,
  extractTraitTypeArguments,
} from "./trait.js";
import { resolveObjectDecl } from "./object.js";
import type { BinderScopeTracker } from "./scope-tracker.js";
import { inheritMemberVisibility, moduleVisibility } from "../../hir/index.js";

const isStaticMethod = (fn: ParsedFunctionDecl): boolean =>
  fn.signature.params.length === 0 ||
  fn.signature.params[0]?.name !== "self";

const recordStaticMethod = ({
  target,
  methodSymbol,
  ctx,
}: {
  target: SymbolId;
  methodSymbol: SymbolId;
  ctx: BindingContext;
}): void => {
  const name = ctx.symbolTable.getSymbol(methodSymbol).name;
  const bucket = ctx.staticMethods.get(target) ?? new Map();
  const methods = bucket.get(name) ?? new Set<SymbolId>();
  methods.add(methodSymbol);
  bucket.set(name, methods);
  ctx.staticMethods.set(target, bucket);
};

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
  const implTargetDecl = resolveObjectDecl(decl.target, ctx, implScope);
  const implTargetSymbol = implTargetDecl?.symbol;
  const ownerVisibility = implTargetDecl?.visibility ?? moduleVisibility();
  const traitSymbolForMemberScope = (() => {
    if (!decl.trait) {
      return undefined;
    }
    const resolved = resolveTraitDecl(decl.trait, ctx, tracker.current());
    if (resolved) {
      return resolved.symbol;
    }
    if (isIdentifierAtom(decl.trait)) {
      return ctx.symbolTable.resolve(decl.trait.value, tracker.current());
    }
    if (isForm(decl.trait) && isIdentifierAtom(decl.trait.first)) {
      return ctx.symbolTable.resolve(decl.trait.first.value, tracker.current());
    }
    return undefined;
  })();

  const memberDeclarationScope = (() => {
    if (typeof implTargetSymbol !== "number") {
      return undefined;
    }
    const existing = ctx.memberDeclarationScopesByOwner.get(implTargetSymbol);
    if (typeof existing === "number") {
      return existing;
    }
    const next = ctx.symbolTable.createScope({
      parent: tracker.current(),
      kind: "members",
      owner: decl.form.syntaxId,
    });
    ctx.memberDeclarationScopesByOwner.set(implTargetSymbol, next);
    return next;
  })();

  const traitMemberDeclarationScope = (() => {
    if (
      typeof implTargetSymbol !== "number" ||
      typeof traitSymbolForMemberScope !== "number"
    ) {
      return undefined;
    }

    const byTrait =
      ctx.memberDeclarationScopesByOwnerAndTrait.get(implTargetSymbol) ?? new Map();
    const existing = byTrait.get(traitSymbolForMemberScope);
    if (typeof existing === "number") {
      return existing;
    }
    const next = ctx.symbolTable.createScope({
      parent: tracker.current(),
      kind: "members",
      owner: decl.form.syntaxId,
    });
    byTrait.set(traitSymbolForMemberScope, next);
    ctx.memberDeclarationScopesByOwnerAndTrait.set(implTargetSymbol, byTrait);
    return next;
  })();

  const methodDeclarationScope = decl.trait
    ? traitMemberDeclarationScope ?? memberDeclarationScope
    : memberDeclarationScope;

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

    const bindMethod = (parsedFn: ParsedFunctionDecl) => {
      const staticMethod = isStaticMethod(parsedFn);
      const metadata: Record<string, unknown> = {
        entity: "function",
        impl: implSymbol,
      };
      if (staticMethod) {
        metadata.static = true;
        if (typeof implTargetSymbol === "number") {
          metadata.implTarget = implTargetSymbol;
        }
      }

      const memberVisibility = inheritMemberVisibility({
        ownerVisibility,
        modifier: parsedFn.memberModifier,
      });

      const method = bindFunctionDecl(parsedFn, ctx, tracker, {
        declarationScope: staticMethod
          ? implScope
          : methodDeclarationScope ?? ctx.symbolTable.rootScope,
        scopeParent: implScope,
        metadata,
        selfTypeExpr: staticMethod ? undefined : decl.target,
        visibilityOverride: memberVisibility,
        memberVisibility,
      });

      if (staticMethod) {
        if (typeof implTargetSymbol === "number") {
          recordStaticMethod({
            target: implTargetSymbol,
            methodSymbol: method.symbol,
            ctx,
          });
        } else {
          ctx.pendingStaticMethods.push({
            targetExpr: decl.target,
            scope: implScope,
            methodSymbol: method.symbol,
          });
        }
      }

      return method;
    };

    decl.body.rest.forEach((entry) => {
      if (!isForm(entry)) {
        return;
      }
      const parsedFn = parseFunctionDecl(entry);
      if (!parsedFn) {
        throw new Error("impl body supports only function declarations");
      }
      methods.push(bindMethod(parsedFn));
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
          methods.push(bindMethod(parsed));
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
    params.forEach((param: TypeParameterDecl, index: number) => {
    const arg = args[index];
    if (arg) {
      substitutions.set(param.name, arg);
    }
  });
  return substitutions.size > 0 ? substitutions : undefined;
};

export const flushPendingStaticMethods = (ctx: BindingContext): void => {
  if (ctx.pendingStaticMethods.length === 0) {
    return;
  }

  ctx.pendingStaticMethods.forEach(({ targetExpr, scope, methodSymbol }) => {
    const targetDecl = resolveObjectDecl(targetExpr, ctx, scope);
    const targetSymbol = targetDecl?.symbol;
    if (typeof targetSymbol !== "number") {
      return;
    }
    recordStaticMethod({
      target: targetSymbol,
      methodSymbol,
      ctx,
    });
  });

  ctx.pendingStaticMethods = [];
};
