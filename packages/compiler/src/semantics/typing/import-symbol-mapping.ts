import { createTypingState } from "./context.js";
import { ensureObjectType, getObjectTemplate } from "./type-system.js";
import { importableMetadataFrom } from "../imports/metadata.js";
import type { DependencySemantics, TypingContext } from "./types.js";
import type { SymbolId, TypeId, TypeParamId } from "../ids.js";
import type {
  HirMethodParameter,
  HirTraitMethod,
  HirTypeExpr,
  HirTypeParameter,
} from "../hir/index.js";
import {
  createTranslation,
  mapTypeParam,
  translateFunctionSignature,
} from "./import-type-translation.js";
import { findExport, makeDependencyContext } from "./import-resolution.js";
import {
  methodSignatureKey,
  methodSignatureParamTypeKey,
} from "../method-signature-key.js";
import { typeExprKey } from "./trait-method-matcher.js";

const targetTypeIncludesDependencySymbol = ({
  type,
  dependency,
  symbol,
}: {
  type: TypeId;
  dependency: DependencySemantics;
  symbol: SymbolId;
}): boolean => {
  const desc = dependency.typing.arena.get(type);
  if (desc.kind === "nominal-object") {
    return (
      desc.owner.moduleId === dependency.moduleId && desc.owner.symbol === symbol
    );
  }
  if (desc.kind === "intersection" && typeof desc.nominal === "number") {
    return targetTypeIncludesDependencySymbol({
      type: desc.nominal,
      dependency,
      symbol,
    });
  }
  if (desc.kind === "recursive") {
    return targetTypeIncludesDependencySymbol({
      type: desc.body,
      dependency,
      symbol,
    });
  }
  return false;
};

const mapImportedTraitMethodSymbol = ({
  dependency,
  dependencyTraitSymbol,
  dependencyTraitMethodSymbol,
  localTraitSymbol,
  ctx,
}: {
  dependency: DependencySemantics;
  dependencyTraitSymbol: SymbolId;
  dependencyTraitMethodSymbol: SymbolId;
  localTraitSymbol: SymbolId;
  ctx: TypingContext;
}): SymbolId => {
  const depTraitDecl = dependency.typing.traits.getDecl(dependencyTraitSymbol);
  const localTraitDecl = ctx.traits.getDecl(localTraitSymbol);
  if (!depTraitDecl || !localTraitDecl) {
    return mapDependencySymbolToLocal({
      owner: dependencyTraitMethodSymbol,
      dependency,
      ctx,
      allowUnexported: true,
    });
  }

  const dependencyMethod = depTraitDecl.methods.find(
    (method) => method.symbol === dependencyTraitMethodSymbol,
  );
  if (dependencyMethod) {
    const dependencyKey = traitMethodMappingKey({
      method: dependencyMethod,
      symbolNameFor: (symbol) => dependency.symbolTable.getSymbol(symbol).name,
    });
    const localMatches = localTraitDecl.methods.filter(
      (method) =>
        traitMethodMappingKey({
          method,
          symbolNameFor: (symbol) => ctx.symbolTable.getSymbol(symbol).name,
        }) === dependencyKey,
    );
    if (localMatches.length === 1) {
      return localMatches[0]!.symbol;
    }
  }

  const depMethodIndex = depTraitDecl.methods.findIndex(
    (method) => method.symbol === dependencyTraitMethodSymbol,
  );
  if (depMethodIndex < 0) {
    return mapDependencySymbolToLocal({
      owner: dependencyTraitMethodSymbol,
      dependency,
      ctx,
      allowUnexported: true,
    });
  }

  const localMethod = localTraitDecl.methods[depMethodIndex];
  if (localMethod) {
    return localMethod.symbol;
  }

  return mapDependencySymbolToLocal({
    owner: dependencyTraitMethodSymbol,
    dependency,
    ctx,
    allowUnexported: true,
  });
};

const traitMethodMappingKey = ({
  method,
  symbolNameFor,
}: {
  method: HirTraitMethod;
  symbolNameFor: (symbol: SymbolId) => string;
}): string => {
  const methodName = symbolNameFor(method.symbol);
  const typeParamCount = method.typeParameters?.length ?? 0;
  const params = method.parameters.map((param, index) => {
    const paramName = symbolNameFor(param.symbol);
    return {
      label: param.label,
      name: paramName,
      typeKey: methodSignatureParamTypeKey({
        index,
        paramName,
        typeKey: typeExprKey(param.type),
      }),
    };
  });
  return methodSignatureKey({ methodName, typeParamCount, params });
};

const translateTraitTypeExpr = ({
  expr,
  translation,
  mapSymbol,
}: {
  expr: HirTypeExpr | undefined;
  translation: (id: TypeId) => TypeId;
  mapSymbol: (symbol: SymbolId | undefined) => SymbolId | undefined;
}): HirTypeExpr | undefined => {
  if (!expr) {
    return undefined;
  }

  const typeId =
    typeof expr.typeId === "number" ? translation(expr.typeId) : undefined;

  switch (expr.typeKind) {
    case "named":
      return {
        ...expr,
        symbol: mapSymbol(expr.symbol),
        typeArguments: expr.typeArguments?.map(
          (arg) =>
            translateTraitTypeExpr({ expr: arg, translation, mapSymbol }) ??
            arg
        ),
        typeId,
      };
    case "object":
      return {
        ...expr,
        fields: expr.fields.map((field) => ({
          ...field,
          type:
            translateTraitTypeExpr({
              expr: field.type,
              translation,
              mapSymbol,
            }) ?? field.type,
        })),
        typeId,
      };
    case "tuple":
      return {
        ...expr,
        elements: expr.elements.map(
          (entry) =>
            translateTraitTypeExpr({ expr: entry, translation, mapSymbol }) ??
            entry
        ),
        typeId,
      };
    case "union":
      return {
        ...expr,
        members: expr.members.map(
          (entry) =>
            translateTraitTypeExpr({ expr: entry, translation, mapSymbol }) ??
            entry
        ),
        typeId,
      };
    case "intersection":
      return {
        ...expr,
        members: expr.members.map(
          (entry) =>
            translateTraitTypeExpr({ expr: entry, translation, mapSymbol }) ??
            entry
        ),
        typeId,
      };
    case "function":
      return {
        ...expr,
        typeParameters: expr.typeParameters?.map((param) =>
          translateTraitTypeParameter({ param, translation, mapSymbol })
        ),
        parameters: expr.parameters.map((param) => ({
          ...param,
          type:
            translateTraitTypeExpr({
              expr: param.type,
              translation,
              mapSymbol,
            }) ?? param.type,
        })),
        returnType:
          translateTraitTypeExpr({
            expr: expr.returnType,
            translation,
            mapSymbol,
          }) ?? expr.returnType,
        effectType: translateTraitTypeExpr({
          expr: expr.effectType,
          translation,
          mapSymbol,
        }),
        typeId,
      };
    case "self":
      return {
        ...expr,
        typeId,
      };
    default: {
      const _exhaustive: never = expr;
      return _exhaustive;
    }
  }
};

const translateTraitTypeParameter = ({
  param,
  translation,
  mapSymbol,
}: {
  param: HirTypeParameter;
  translation: (id: TypeId) => TypeId;
  mapSymbol: (symbol: SymbolId | undefined) => SymbolId | undefined;
}): HirTypeParameter => ({
  ...param,
  symbol: mapSymbol(param.symbol) ?? param.symbol,
  constraint: translateTraitTypeExpr({
    expr: param.constraint,
    translation,
    mapSymbol,
  }),
  defaultType: translateTraitTypeExpr({
    expr: param.defaultType,
    translation,
    mapSymbol,
  }),
});

const translateTraitMethodParameter = ({
  parameter,
  translation,
  mapSymbol,
}: {
  parameter: HirMethodParameter;
  translation: (id: TypeId) => TypeId;
  mapSymbol: (symbol: SymbolId | undefined) => SymbolId | undefined;
}): HirMethodParameter => ({
  ...parameter,
  symbol: mapSymbol(parameter.symbol) ?? parameter.symbol,
  type: translateTraitTypeExpr({
    expr: parameter.type,
    translation,
    mapSymbol,
  }),
});

const translateTraitMethod = ({
  method,
  translation,
  mapSymbol,
}: {
  method: HirTraitMethod;
  translation: (id: TypeId) => TypeId;
  mapSymbol: (symbol: SymbolId | undefined) => SymbolId | undefined;
}): HirTraitMethod => ({
  ...method,
  symbol: mapSymbol(method.symbol) ?? method.symbol,
  typeParameters: method.typeParameters?.map((param) =>
    translateTraitTypeParameter({ param, translation, mapSymbol })
  ),
  parameters: method.parameters.map((parameter) =>
    translateTraitMethodParameter({ parameter, translation, mapSymbol })
  ),
  returnType: translateTraitTypeExpr({
    expr: method.returnType,
    translation,
    mapSymbol,
  }),
  effectType: translateTraitTypeExpr({
    expr: method.effectType,
    translation,
    mapSymbol,
  }),
});

export const registerImportedObjectTemplate = ({
  dependency,
  dependencySymbol,
  localSymbol,
  ctx,
}: {
  dependency: DependencySemantics;
  dependencySymbol: SymbolId;
  localSymbol: SymbolId;
  ctx: TypingContext;
}): void => {
  if (ctx.objects.getTemplate(localSymbol)) {
    return;
  }
  let template = dependency.typing.objects.getTemplate(dependencySymbol);
  if (!template) {
    const depCtx = makeDependencyContext(dependency, ctx);
    const state = createTypingState();
    template = getObjectTemplate(dependencySymbol, depCtx, state);
  }
  if (!template) {
    return;
  }

  const typeParamMap = new Map<TypeParamId, TypeParamId>();
  const cache = new Map<TypeId, TypeId>();
  const mapOwner = (symbol: SymbolId): SymbolId => {
    if (symbol === dependencySymbol) {
      return localSymbol;
    }
    if (symbol === dependency.typing.objects.base.symbol) {
      return ctx.objects.base.symbol;
    }
    try {
      return mapDependencySymbolToLocal({ owner: symbol, dependency, ctx });
    } catch {
      const depRecord = dependency.symbolTable.getSymbol(symbol);
      return ctx.symbolTable.declare({
        name: depRecord.name,
        kind: depRecord.kind,
        declaredAt: ctx.hir.module.ast,
      });
    }
  };
  const translation = createTranslation({
    sourceArena: dependency.typing.arena,
    targetArena: ctx.arena,
    sourceEffects: dependency.typing.effects,
    targetEffects: ctx.effects,
    paramMap: typeParamMap,
    cache,
    mapSymbol: mapOwner,
  });

  const paramSymbolMap = new Map<SymbolId, SymbolId>();
  const mapParamSymbol = (symbol: SymbolId): SymbolId => {
    const existing = paramSymbolMap.get(symbol);
    if (typeof existing === "number") {
      return existing;
    }
    const depRecord = dependency.symbolTable.getSymbol(symbol);
    const local = ctx.symbolTable.declare({
      name: depRecord.name,
      kind: "type-parameter",
      declaredAt: ctx.hir.module.ast,
    });
    paramSymbolMap.set(symbol, local);
    return local;
  };

  const translateTypeParam = (id: TypeParamId | undefined) =>
    typeof id === "number" ? typeParamMap.get(id) ?? id : undefined;

  const translateDeclaringParams = (
    params?: readonly TypeParamId[],
  ): readonly TypeParamId[] | undefined => {
    const translated = params
      ?.map(translateTypeParam)
      .filter((entry): entry is TypeParamId => typeof entry === "number");
    return translated && translated.length > 0 ? translated : undefined;
  };

  const params = template.params.map((param) => ({
    symbol: mapParamSymbol(param.symbol),
    typeParam: mapTypeParam(param.typeParam, typeParamMap, ctx),
    constraint: param.constraint ? translation(param.constraint) : undefined,
  }));

  const dependencyTraitSymbols = new Set<SymbolId>();
  const seenConstraintTypes = new Set<TypeId>();
  const collectConstraintTraits = (type: TypeId): void => {
    if (seenConstraintTypes.has(type)) {
      return;
    }
    seenConstraintTypes.add(type);

    const desc = dependency.typing.arena.get(type);
    if (desc.kind === "trait") {
      if (desc.owner.moduleId === dependency.moduleId) {
        dependencyTraitSymbols.add(desc.owner.symbol);
      }
      desc.typeArgs.forEach(collectConstraintTraits);
      return;
    }
    if (desc.kind === "intersection") {
      desc.traits?.forEach(collectConstraintTraits);
      if (typeof desc.nominal === "number") {
        collectConstraintTraits(desc.nominal);
      }
      if (typeof desc.structural === "number") {
        collectConstraintTraits(desc.structural);
      }
      return;
    }
    if (desc.kind === "nominal-object") {
      desc.typeArgs.forEach(collectConstraintTraits);
      return;
    }
    if (desc.kind === "structural-object") {
      desc.fields.forEach((field) => collectConstraintTraits(field.type));
      return;
    }
    if (desc.kind === "function") {
      desc.parameters.forEach((param) => collectConstraintTraits(param.type));
      collectConstraintTraits(desc.returnType);
      return;
    }
    if (desc.kind === "union") {
      desc.members.forEach(collectConstraintTraits);
      return;
    }
    if (desc.kind === "recursive") {
      collectConstraintTraits(desc.body);
      return;
    }
    if (desc.kind === "fixed-array") {
      collectConstraintTraits(desc.element);
    }
  };
  template.params.forEach((param) => {
    if (typeof param.constraint === "number") {
      collectConstraintTraits(param.constraint);
    }
  });
  dependencyTraitSymbols.forEach((traitSymbol) => {
    const localTraitSymbol = mapDependencySymbolToLocal({
      owner: traitSymbol,
      dependency,
      ctx,
      allowUnexported: true,
    });
    registerImportedTraitDecl({
      dependency,
      dependencySymbol: traitSymbol,
      localSymbol: localTraitSymbol,
      ctx,
    });
    registerImportedTraitImplTemplates({
      dependency,
      dependencySymbol: traitSymbol,
      ctx,
    });
  });

  const fields = template.fields.map((field) => ({
    name: field.name,
    type: translation(field.type),
    declaringParams: translateDeclaringParams(field.declaringParams),
    visibility: field.visibility,
    owner:
      typeof field.owner === "number" ? mapOwner(field.owner) : field.owner,
    packageId: field.packageId ?? dependency.packageId ?? ctx.packageId,
  }));

  ctx.objects.registerTemplate({
    symbol: localSymbol,
    params,
    nominal: translation(template.nominal),
    structural: translation(template.structural),
    type: translation(template.type),
    fields,
    visibility: template.visibility,
    baseNominal: template.baseNominal
      ? translation(template.baseNominal)
      : undefined,
  });
  const name = ctx.symbolTable.getSymbol(localSymbol).name;
  ctx.objects.setName(name, localSymbol);
  if (params.length === 0) {
    const state = createTypingState();
    ensureObjectType(localSymbol, ctx, state, []);
  }
};

export const registerImportedTraitDecl = ({
  dependency,
  dependencySymbol,
  localSymbol,
  ctx,
}: {
  dependency: DependencySemantics;
  dependencySymbol: SymbolId;
  localSymbol: SymbolId;
  ctx: TypingContext;
}): void => {
  if (ctx.traits.getDecl(localSymbol)) {
    return;
  }
  const traitDecl = dependency.typing.traits.getDecl(dependencySymbol);
  if (!traitDecl) {
    return;
  }

  const symbolMap = new Map<SymbolId, SymbolId>();
  symbolMap.set(dependencySymbol, localSymbol);

  const mapSymbol = (symbol: SymbolId): SymbolId => {
    const existing = symbolMap.get(symbol);
    if (typeof existing === "number") {
      return existing;
    }
    const record = dependency.symbolTable.getSymbol(symbol);
    const mapped = ctx.symbolTable.declare({
      name: record.name,
      kind: record.kind,
      declaredAt: ctx.hir.module.ast,
    });
    symbolMap.set(symbol, mapped);
    return mapped;
  };
  const typeParamMap = new Map<TypeParamId, TypeParamId>();
  const cache = new Map<TypeId, TypeId>();
  const translation = createTranslation({
    sourceArena: dependency.typing.arena,
    targetArena: ctx.arena,
    sourceEffects: dependency.typing.effects,
    targetEffects: ctx.effects,
    paramMap: typeParamMap,
    cache,
    mapSymbol: (owner) =>
      mapDependencySymbolToLocal({
        owner,
        dependency,
        ctx,
        allowUnexported: true,
      }),
  });
  const mapTypeExprSymbol = (
    symbol: SymbolId | undefined,
  ): SymbolId | undefined => {
    if (typeof symbol !== "number") {
      return symbol;
    }
    const existing = symbolMap.get(symbol);
    if (typeof existing === "number") {
      return existing;
    }
    let record: Readonly<{ kind: string }>;
    try {
      record = dependency.symbolTable.getSymbol(symbol);
    } catch {
      return symbol;
    }
    return record.kind === "type-parameter"
      ? mapSymbol(symbol)
      : mapDependencySymbolToLocal({
          owner: symbol,
          dependency,
          ctx,
          allowUnexported: true,
        });
  };

  ctx.traits.registerDecl({
    ...traitDecl,
    symbol: localSymbol,
    typeParameters: traitDecl.typeParameters?.map((param) =>
      translateTraitTypeParameter({
        param,
        translation,
        mapSymbol: mapTypeExprSymbol,
      })
    ),
    requirements: traitDecl.requirements?.map((requirement) =>
      translateTraitTypeExpr({
        expr: requirement,
        translation,
        mapSymbol: mapTypeExprSymbol,
      }) ?? requirement
    ),
    methods: traitDecl.methods.map((method) =>
      translateTraitMethod({
        method: {
          ...method,
          symbol: mapDependencySymbolToLocal({
            owner: method.symbol,
            dependency,
            ctx,
            allowUnexported: true,
          }),
        },
        translation,
        mapSymbol: mapTypeExprSymbol,
      })
    ),
  });
  const name = ctx.symbolTable.getSymbol(localSymbol).name;
  ctx.traits.setName(name, localSymbol);
};

export const registerImportedTraitImplTemplates = ({
  dependency,
  dependencySymbol,
  ctx,
}: {
  dependency: DependencySemantics;
  dependencySymbol: SymbolId;
  ctx: TypingContext;
}): void => {
  const dependencyRecord = dependency.symbolTable.getSymbol(dependencySymbol);
  const dependencyIsTrait = dependencyRecord.kind === "trait";
  const relevantTemplates = dependency.typing.traits
    .getImplTemplates()
    .filter(
      (template) =>
        (dependencyIsTrait && template.traitSymbol === dependencySymbol) ||
        targetTypeIncludesDependencySymbol({
          type: template.target,
          dependency,
          symbol: dependencySymbol,
        }),
    );

  if (relevantTemplates.length === 0) {
    return;
  }

  relevantTemplates.forEach((template) => {
    const localTraitSymbol = mapDependencySymbolToLocal({
      owner: template.traitSymbol,
      dependency,
      ctx,
      allowUnexported: true,
    });
    registerImportedTraitDecl({
      dependency,
      dependencySymbol: template.traitSymbol,
      localSymbol: localTraitSymbol,
      ctx,
    });

    const localImplSymbol = mapDependencySymbolToLocal({
      owner: template.implSymbol,
      dependency,
      ctx,
      allowUnexported: true,
    });
    const templateAlreadyRegistered = ctx.traits
      .getImplTemplates()
      .some((entry) => entry.implSymbol === localImplSymbol);
    if (templateAlreadyRegistered) {
      return;
    }

    const typeParamMap = new Map<TypeParamId, TypeParamId>();
    const cache = new Map<TypeId, TypeId>();
    const translation = createTranslation({
      sourceArena: dependency.typing.arena,
      targetArena: ctx.arena,
      sourceEffects: dependency.typing.effects,
      targetEffects: ctx.effects,
      paramMap: typeParamMap,
      cache,
      mapSymbol: (owner) =>
        mapDependencySymbolToLocal({
          owner,
          dependency,
          ctx,
          allowUnexported: true,
        }),
    });

    const typeParamSymbolMap = new Map<SymbolId, SymbolId>();
    const mapTypeParamSymbol = (symbol: SymbolId): SymbolId => {
      const existing = typeParamSymbolMap.get(symbol);
      if (typeof existing === "number") {
        return existing;
      }
      const depRecord = dependency.symbolTable.getSymbol(symbol);
      const local = ctx.symbolTable.declare({
        name: depRecord.name,
        kind: "type-parameter",
        declaredAt: ctx.hir.module.ast,
      });
      typeParamSymbolMap.set(symbol, local);
      return local;
    };

    const methods = new Map<SymbolId, SymbolId>();
    template.methods.forEach(
      (dependencyImplMethodSymbol, dependencyTraitMethodSymbol) => {
        const traitMethodSymbol = mapImportedTraitMethodSymbol({
          dependency,
          dependencyTraitSymbol: template.traitSymbol,
          dependencyTraitMethodSymbol,
          localTraitSymbol,
          ctx,
        });
        const implMethodSymbol = mapDependencySymbolToLocal({
          owner: dependencyImplMethodSymbol,
          dependency,
          ctx,
          allowUnexported: true,
        });
        methods.set(traitMethodSymbol, implMethodSymbol);

        if (!ctx.functions.getSignature(implMethodSymbol)) {
          const dependencySignature =
            dependency.typing.functions.getSignature(dependencyImplMethodSymbol);
          if (dependencySignature) {
            const signatureTypeParamMap = new Map<TypeParamId, TypeParamId>();
            const signatureCache = new Map<TypeId, TypeId>();
            const signatureTranslation = createTranslation({
              sourceArena: dependency.typing.arena,
              targetArena: ctx.arena,
              sourceEffects: dependency.typing.effects,
              targetEffects: ctx.effects,
              paramMap: signatureTypeParamMap,
              cache: signatureCache,
              mapSymbol: (owner) =>
                mapDependencySymbolToLocal({
                  owner,
                  dependency,
                  ctx,
                  allowUnexported: true,
                }),
            });
            const translated = translateFunctionSignature({
              signature: dependencySignature,
              translation: signatureTranslation,
              dependency,
              ctx,
              paramMap: signatureTypeParamMap,
            });
            ctx.functions.setSignature(implMethodSymbol, translated.signature);
            ctx.table.setSymbolScheme(implMethodSymbol, translated.signature.scheme);
            ctx.valueTypes.set(implMethodSymbol, translated.signature.typeId);
          }
        }
      },
    );

    ctx.traits.registerImplTemplate({
      trait: translation(template.trait),
      traitSymbol: localTraitSymbol,
      target: translation(template.target),
      typeParams: template.typeParams.map((param) => ({
        symbol: mapTypeParamSymbol(param.symbol),
        typeParam: mapTypeParam(param.typeParam, typeParamMap, ctx),
        constraint: param.constraint ? translation(param.constraint) : undefined,
        typeRef: translation(param.typeRef),
      })),
      methods,
      implSymbol: localImplSymbol,
    });

    methods.forEach((implMethodSymbol, traitMethodSymbol) => {
      if (ctx.traitMethodImpls.has(implMethodSymbol)) {
        return;
      }
      ctx.traitMethodImpls.set(implMethodSymbol, {
        traitSymbol: localTraitSymbol,
        traitMethodSymbol,
      });
    });
  });
};

export const mapDependencySymbolToLocal = ({
  owner,
  dependency,
  ctx,
  allowUnexported,
}: {
  owner: SymbolId;
  dependency: DependencySemantics;
  ctx: TypingContext;
  allowUnexported?: boolean;
}): SymbolId => {
  const visit = (
    candidateOwner: SymbolId,
    candidateDependency: DependencySemantics,
    seen: Set<string>,
  ): SymbolId => {
    const key = `${candidateDependency.moduleId}::${candidateOwner}`;
    if (seen.has(key)) {
      throw new Error(
        `cyclic import metadata while resolving symbol ${candidateOwner}`,
      );
    }
    seen.add(key);

    const aliases = ctx.importAliasesByModule.get(candidateDependency.moduleId);
    const aliased = aliases?.get(candidateOwner);
    if (typeof aliased === "number") {
      return aliased;
    }

    const exportEntry = findExport(candidateOwner, candidateDependency);
    if (!exportEntry) {
      const record = candidateDependency.symbolTable.getSymbol(candidateOwner);
      const importMetadata = (record.metadata ?? {}) as
        | { import?: { moduleId?: unknown; symbol?: unknown } }
        | undefined;
      const importModuleId = importMetadata?.import?.moduleId;
      const importSymbol = importMetadata?.import?.symbol;

      if (
        typeof importModuleId === "string" &&
        typeof importSymbol === "number"
      ) {
        const importedDependency = ctx.dependencies.get(importModuleId);
        if (importedDependency) {
          return visit(importSymbol, importedDependency, seen);
        }
      }

      if (allowUnexported === true) {
        const recordName = record.name;
        const importableMetadata = importableMetadataFrom(
          record.metadata as Record<string, unknown> | undefined,
        );
        const declared = ctx.symbolTable.declare({
          name: recordName,
          kind: record.kind,
          declaredAt: ctx.hir.module.ast,
          metadata: {
            import: {
              moduleId: candidateDependency.moduleId,
              symbol: candidateOwner,
            },
            ...(importableMetadata ?? {}),
          },
        });
        ctx.importsByLocal.set(declared, {
          moduleId: candidateDependency.moduleId,
          symbol: candidateOwner,
        });
        const bucket =
          ctx.importAliasesByModule.get(candidateDependency.moduleId) ??
          new Map();
        bucket.set(candidateOwner, declared);
        ctx.importAliasesByModule.set(candidateDependency.moduleId, bucket);
        if (
          record.kind === "type" ||
          candidateDependency.typing.objects.getTemplate(candidateOwner)
        ) {
          registerImportedObjectTemplate({
            dependency: candidateDependency,
            dependencySymbol: candidateOwner,
            localSymbol: declared,
            ctx,
          });
        }
        return declared;
      }

      throw new Error(
        `module ${candidateDependency.moduleId} does not export symbol ${candidateOwner}`,
      );
    }

    const dependencyRecord = candidateDependency.symbolTable.getSymbol(
      candidateOwner,
    );
    const importableMetadata = importableMetadataFrom(
      dependencyRecord.metadata as Record<string, unknown> | undefined,
    );
    const declared = ctx.symbolTable.declare({
      name: exportEntry.name,
      kind: exportEntry.kind,
      declaredAt: ctx.hir.module.ast,
      metadata: {
        import: { moduleId: candidateDependency.moduleId, symbol: candidateOwner },
        ...(importableMetadata ?? {}),
      },
    });
    ctx.importsByLocal.set(declared, {
      moduleId: candidateDependency.moduleId,
      symbol: candidateOwner,
    });
    const bucket =
      ctx.importAliasesByModule.get(candidateDependency.moduleId) ?? new Map();
    bucket.set(candidateOwner, declared);
    ctx.importAliasesByModule.set(candidateDependency.moduleId, bucket);
    if (
      exportEntry.kind === "type" ||
      candidateDependency.typing.objects.getTemplate(candidateOwner)
    ) {
      registerImportedObjectTemplate({
        dependency: candidateDependency,
        dependencySymbol: candidateOwner,
        localSymbol: declared,
        ctx,
      });
    }
    return declared;
  };

  return visit(owner, dependency, new Set());
};
