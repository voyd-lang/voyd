import { type Expr, isIdentifierAtom, isForm } from "../../../parser/index.js";
import { declarationDocForSyntax, rememberSyntax } from "../context.js";
import type { TypeParameterDecl, TraitDecl } from "../../decls.js";
import type { BindingContext, BindingResult } from "../types.js";
import type { ParsedFunctionDecl, ParsedImplDecl } from "../parsing.js";
import { parseFunctionDecl } from "../parsing.js";
import type { ScopeId, SymbolId } from "../../ids.js";
import { bindFunctionDecl } from "./function.js";
import {
  makeParsedFunctionFromTraitMethod,
  resolveTraitDecl,
  extractTraitTypeArguments,
} from "./trait.js";
import { bindTypeParameters } from "./type-parameters.js";
import { resolveObjectDecl } from "./object.js";
import type { BinderScopeTracker } from "./scope-tracker.js";
import { inheritMemberVisibility, moduleVisibility } from "../../hir/index.js";
import { formatTypeAnnotation } from "../../utils.js";
import { importableMetadataFrom, importedModuleIdFrom } from "../../imports/metadata.js";
import {
  methodSignatureKey,
  methodSignatureParamTypeKey,
} from "../../method-signature-key.js";

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
  const traitResolution = decl.trait
    ? resolveTraitDecl(decl.trait, ctx, tracker.current())
    : undefined;
  const traitSymbolForMemberScope = (() => {
    if (traitResolution) {
      return traitResolution.localSymbol;
    }
    if (!decl.trait) {
      return undefined;
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
    typeParameters.push(...bindTypeParameters(decl.typeParameters, ctx));

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

    const bindMethod = (
      parsedFn: ParsedFunctionDecl,
      options?: { scopeParent?: ScopeId },
    ) => {
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
        scopeParent: options?.scopeParent ?? implScope,
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
      const traitDecl = traitResolution?.decl;
      if (traitDecl) {
        const traitTypeParamMap = buildTraitTypeParamMap(traitDecl, decl.trait);
        const methodSignatures = new Set(
          methods.map((method) => methodSignatureKeyForBoundFunction(method))
        );
        traitDecl.methods.forEach((traitMethod) => {
          if (!traitMethod.defaultBody) {
            return;
          }
          const parsed = makeParsedFunctionFromTraitMethod(traitMethod, {
            typeParamSubstitutions: traitTypeParamMap,
          });
          const signature = methodSignatureKeyForParsedFunction(parsed);
          if (methodSignatures.has(signature)) {
            return;
          }
          const method = bindMethod(parsed, {
            scopeParent:
              createImportedTraitDefaultScope({
                implScope,
                sourceModuleId: traitResolution.sourceModuleId,
                sourceSymbolTable: traitResolution.sourceSymbolTable,
                sourceMethodScope: traitMethod.scope,
                ownerSyntaxId: decl.form.syntaxId,
                parsedDefaultMethod: parsed,
                ctx,
              }) ?? implScope,
          });
          methods.push(method);
          methodSignatures.add(signature);
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
    documentation: declarationDocForSyntax(decl.target, ctx),
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

  const traitDecl = trait ? resolveTraitDecl(trait, ctx, scope)?.decl : undefined;
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

const createImportedTraitDefaultScope = ({
  implScope,
  sourceModuleId,
  sourceSymbolTable,
  sourceMethodScope,
  ownerSyntaxId,
  parsedDefaultMethod,
  ctx,
}: {
  implScope: ScopeId;
  sourceModuleId: string;
  sourceSymbolTable: BindingContext["symbolTable"];
  sourceMethodScope: ScopeId;
  ownerSyntaxId: number;
  parsedDefaultMethod: ParsedFunctionDecl;
  ctx: BindingContext;
}): ScopeId | undefined => {
  if (sourceModuleId === ctx.module.id) {
    return undefined;
  }

  const referencedNames = collectReferencedIdentifierNames({
    parsedDefaultMethod,
  });
  const sourceBinding = ctx.dependencies.get(sourceModuleId);
  const importCandidates = collectImportCandidatesForReferencedNames({
    names: referencedNames,
    fromScope: sourceMethodScope,
    symbolTable: sourceSymbolTable,
    sourceOverloadBySymbol: sourceBinding?.overloadBySymbol,
    sourceOverloadOptions: sourceBinding
      ? collectOverloadOptionsBySetId(sourceBinding)
      : undefined,
  });
  if (importCandidates.length === 0) {
    return undefined;
  }

  const importedScope = ctx.symbolTable.createScope({
    parent: implScope,
    kind: "block",
    owner: ownerSyntaxId,
  });

  importCandidates.forEach(({ candidates }) => {
    const importedLocals = candidates.map(({ symbol, record }) => {
      const sourceMetadata = (record.metadata ?? {}) as {
        import?: { moduleId?: unknown; symbol?: unknown };
      };
      const importedModuleId =
        importedModuleIdFrom(record.metadata as Record<string, unknown> | undefined) ??
        sourceModuleId;
      const importedSymbol =
        typeof sourceMetadata.import?.symbol === "number"
          ? sourceMetadata.import.symbol
          : symbol;
      const importableMetadata = importableMetadataFrom(
        record.metadata as Record<string, unknown> | undefined,
      );

      return ctx.symbolTable.declare(
        {
          name: record.name,
          kind: record.kind,
          declaredAt: ownerSyntaxId,
          metadata: {
            import:
              record.kind === "module"
                ? { moduleId: importedModuleId }
                : { moduleId: importedModuleId, symbol: importedSymbol },
            ...(importableMetadata ?? {}),
          },
        },
        importedScope,
      );
    });

    if (importedLocals.length <= 1) {
      return;
    }
    const nextOverloadSetId =
      Math.max(-1, ...ctx.importedOverloadOptions.keys(), ...ctx.overloads.keys()) +
      1;
    ctx.importedOverloadOptions.set(nextOverloadSetId, importedLocals);
    importedLocals.forEach((local) => {
      ctx.overloadBySymbol.set(local, nextOverloadSetId);
    });
  });

  return importedScope;
};

const collectImportCandidatesForReferencedNames = ({
  names,
  fromScope,
  symbolTable,
  sourceOverloadBySymbol,
  sourceOverloadOptions,
}: {
  names: ReadonlySet<string>;
  fromScope: ScopeId;
  symbolTable: BindingContext["symbolTable"];
  sourceOverloadBySymbol?: ReadonlyMap<SymbolId, number>;
  sourceOverloadOptions?: ReadonlyMap<number, readonly SymbolId[]>;
}): {
  name: string;
  candidates: { symbol: SymbolId; record: ReturnType<typeof symbolTable.getSymbol> }[];
}[] => {
  const candidatesByName = new Map<
    string,
    { symbol: SymbolId; record: ReturnType<typeof symbolTable.getSymbol> }[]
  >();
  names.forEach((name) => {
    const nearest = nearestScopedSymbolsForName({
      name,
      fromScope,
      symbolTable,
    });
    if (!nearest || nearest.scope === fromScope) {
      return;
    }
    const symbols = expandOverloadCandidates({
      symbols: nearest.symbols,
      sourceOverloadBySymbol,
      sourceOverloadOptions,
    });
    const candidates = symbols
      .map((symbol) => ({ symbol, record: symbolTable.getSymbol(symbol) }))
      .filter(({ record }) => {
        if (record.name !== name) {
          return false;
        }
        if (
          record.name === "void" ||
          record.kind === "parameter" ||
          record.kind === "type-parameter"
        ) {
          return false;
        }
        const metadata = (record.metadata ?? {}) as { entity?: unknown };
        return metadata.entity !== "trait-method";
      });
    if (candidates.length === 0) {
      return;
    }
    candidatesByName.set(name, candidates);
  });
  return Array.from(candidatesByName.entries()).map(([name, candidates]) => ({
    name,
    candidates,
  }));
};

const expandOverloadCandidates = ({
  symbols,
  sourceOverloadBySymbol,
  sourceOverloadOptions,
}: {
  symbols: readonly SymbolId[];
  sourceOverloadBySymbol?: ReadonlyMap<SymbolId, number>;
  sourceOverloadOptions?: ReadonlyMap<number, readonly SymbolId[]>;
}): SymbolId[] => {
  const expanded = new Set<SymbolId>();
  symbols.forEach((symbol) => {
    const overloadSetId = sourceOverloadBySymbol?.get(symbol);
    if (typeof overloadSetId !== "number") {
      expanded.add(symbol);
      return;
    }
    const overloadSymbols = sourceOverloadOptions?.get(overloadSetId);
    if (!overloadSymbols || overloadSymbols.length === 0) {
      expanded.add(symbol);
      return;
    }
    overloadSymbols.forEach((option) => expanded.add(option));
  });
  return Array.from(expanded);
};

const collectOverloadOptionsBySetId = (
  binding: BindingResult,
): Map<number, readonly SymbolId[]> => {
  const options = new Map<number, readonly SymbolId[]>();
  binding.overloads.forEach((set, id) => {
    options.set(
      id,
      set.functions.map((fn) => fn.symbol),
    );
  });
  binding.importedOverloadOptions.forEach((symbols, id) => {
    options.set(id, symbols);
  });
  return options;
};

const nearestScopedSymbolsForName = ({
  name,
  fromScope,
  symbolTable,
}: {
  name: string;
  fromScope: ScopeId;
  symbolTable: BindingContext["symbolTable"];
}): { scope: ScopeId; symbols: SymbolId[] } | undefined => {
  let scope: ScopeId | null = fromScope;
  while (typeof scope === "number") {
    const symbols = Array.from(symbolTable.symbolsInScope(scope)).filter(
      (symbol) => symbolTable.getSymbol(symbol).name === name,
    );
    if (symbols.length > 0) {
      return { scope, symbols };
    }
    scope = symbolTable.getScope(scope).parent;
  }
  return undefined;
};

const collectReferencedIdentifierNames = ({
  parsedDefaultMethod,
}: {
  parsedDefaultMethod: ParsedFunctionDecl;
}): ReadonlySet<string> => {
  const names = new Set<string>();
  collectIdentifierNamesFromExpr(parsedDefaultMethod.body, names);
  parsedDefaultMethod.signature.params.forEach((param) => {
    collectIdentifierNamesFromExpr(param.typeExpr, names);
  });
  collectIdentifierNamesFromExpr(parsedDefaultMethod.signature.returnType, names);
  collectIdentifierNamesFromExpr(parsedDefaultMethod.signature.effectType, names);
  parsedDefaultMethod.signature.typeParameters.forEach((typeParam) => {
    collectIdentifierNamesFromExpr(typeParam.constraint, names);
  });
  return names;
};

const collectIdentifierNamesFromExpr = (
  expr: Expr | undefined,
  names: Set<string>,
): void => {
  if (!expr) {
    return;
  }
  if (isIdentifierAtom(expr)) {
    names.add(expr.value);
    return;
  }
  if (!isForm(expr)) {
    return;
  }
  expr.toArray().forEach((entry) => {
    collectIdentifierNamesFromExpr(entry, names);
  });
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

const methodSignatureKeyForBoundFunction = (
  fn: ReturnType<typeof bindFunctionDecl>,
): string => {
  const params = fn.params.map((param, index) => ({
    label: param.label,
    name: param.name,
    typeKey: methodSignatureParamTypeKey({
      index,
      paramName: param.name,
      typeKey: formatTypeAnnotation(param.typeExpr),
    }),
  }));
  return methodSignatureKey({
    methodName: fn.name,
    typeParamCount: fn.typeParameters?.length ?? 0,
    params,
  });
};

const methodSignatureKeyForParsedFunction = (fn: ParsedFunctionDecl): string => {
  const params = fn.signature.params.map((param, index) => ({
    label: param.label,
    name: param.name,
    typeKey: methodSignatureParamTypeKey({
      index,
      paramName: param.name,
      typeKey: formatTypeAnnotation(param.typeExpr),
    }),
  }));
  return methodSignatureKey({
    methodName: fn.signature.name.value,
    typeParamCount: fn.signature.typeParameters.length,
    params,
  });
};
