import { createTypingState } from "./context.js";
import {
  ensureObjectType,
  ensureTraitType,
  resolveTypeAlias,
} from "./type-system.js";
import {
  applyImportableMetadata,
  importableMetadataFrom,
} from "../imports/metadata.js";
import type {
  DependencySemantics,
  FunctionSignature,
  TypingContext,
  TypingState,
} from "./types.js";
import { DiagnosticEmitter } from "../../diagnostics/index.js";
import type { HirNamedTypeExpr } from "../hir/index.js";
import type {
  SymbolId,
  TypeId,
  TypeParamId,
  TypeSchemeId,
} from "../ids.js";
import type { ModuleExportEntry } from "../modules.js";

type ImportTarget = { moduleId: string; symbol: SymbolId };

type TranslationContext = {
  sourceArena: TypingContext["arena"];
  targetArena: TypingContext["arena"];
  paramMap: Map<TypeParamId, TypeParamId>;
  cache: Map<TypeId, TypeId>;
  mapSymbol: (symbol: SymbolId) => SymbolId;
};

export const importTargetFor = (
  symbol: SymbolId,
  ctx: TypingContext
): ImportTarget | undefined => {
  const mapped = ctx.importsByLocal.get(symbol);
  if (mapped) {
    return mapped;
  }

  const record = ctx.symbolTable.getSymbol(symbol);
  const metadata = (record.metadata ?? {}) as {
    import?: { moduleId: string; symbol: SymbolId };
  };
  return metadata.import;
};

export const resolveImportedValue = ({
  symbol,
  ctx,
}: {
  symbol: SymbolId;
  ctx: TypingContext;
}): { type: TypeId; scheme?: TypeSchemeId } | undefined => {
  const target = importTargetFor(symbol, ctx);
  if (!target) {
    return undefined;
  }

  const dependency = ctx.dependencies.get(target.moduleId);
  if (!dependency) {
    throw new Error(
      `missing semantics for imported module ${target.moduleId}`
    );
  }
  const dependencyRecord = dependency.symbolTable.getSymbol(target.symbol);
  applyImportableMetadata({
    symbolTable: ctx.symbolTable,
    symbol,
    source: dependencyRecord.metadata as Record<string, unknown> | undefined,
  });
  const dependencyMemberMetadata =
    dependency.typing.memberMetadata.get(target.symbol);
  if (dependencyMemberMetadata) {
    const owner =
      typeof dependencyMemberMetadata.owner === "number"
        ? mapDependencySymbolToLocal({
            owner: dependencyMemberMetadata.owner,
            dependency,
            ctx,
          })
        : undefined;
    ctx.memberMetadata.set(symbol, {
      owner,
      visibility: dependencyMemberMetadata.visibility,
      packageId: dependencyMemberMetadata.packageId ?? dependency.packageId,
    });
  }
  registerImportedObjectTemplate({
    dependency,
    dependencySymbol: target.symbol,
    localSymbol: symbol,
    ctx,
  });

  const exportEntry = findExport(target.symbol, dependency);
  if (!exportEntry) {
    throw new Error(
      `module ${target.moduleId} does not export symbol ${target.symbol}`
    );
  }

  const paramMap = new Map<TypeParamId, TypeParamId>();
  const cache = new Map<TypeId, TypeId>();
  const translation = createTranslation({
    sourceArena: dependency.typing.arena,
    targetArena: ctx.arena,
    paramMap,
    cache,
    mapSymbol: (owner) =>
      mapDependencySymbolToLocal({
        owner,
        dependency,
        ctx,
      }),
  });

  const schemeId = dependency.typing.table.getSymbolScheme(target.symbol);
  let scheme: TypeSchemeId | undefined;
  if (typeof schemeId === "number") {
    const sourceScheme = dependency.typing.arena.getScheme(schemeId);
    const params = sourceScheme.params.map((param) =>
      mapTypeParam(param, paramMap, ctx)
    );
    const body = translation(sourceScheme.body);
    const constraints = sourceScheme.constraints
      ? {
          traits: sourceScheme.constraints.traits?.map(translation),
          structural: sourceScheme.constraints.structural?.map((entry) => ({
            field: entry.field,
            type: translation(entry.type),
          })),
        }
      : undefined;
    scheme = ctx.arena.newScheme(params, body, constraints);
    ctx.table.setSymbolScheme(symbol, scheme);
    ctx.valueTypes.set(symbol, body);
  }

  const signature = dependency.typing.functions.getSignature(target.symbol);
  if (signature) {
    const translated = translateFunctionSignature({
      signature,
      translation,
      dependency,
      ctx,
      paramMap,
    });
    ctx.functions.setSignature(symbol, translated.signature);
    if (!scheme) {
      scheme = translated.signature.scheme;
      ctx.table.setSymbolScheme(symbol, scheme);
    }
    ctx.valueTypes.set(symbol, translated.signature.typeId);
    return { type: translated.signature.typeId, scheme };
  }

  if (typeof scheme === "number") {
    return { type: ctx.arena.getScheme(scheme).body, scheme };
  }

  return undefined;
};

export const resolveImportedTypeExpr = ({
  expr,
  typeArgs,
  ctx,
  state,
}: {
  expr: HirNamedTypeExpr;
  typeArgs: readonly TypeId[];
  ctx: TypingContext;
  state: TypingState;
}): TypeId | undefined => {
  const symbol = expr.symbol;
  if (typeof symbol !== "number") {
    return undefined;
  }
  const target = importTargetFor(symbol, ctx);
  if (!target) {
    return undefined;
  }

  const dependency = ctx.dependencies.get(target.moduleId);
  if (!dependency) {
    throw new Error(
      `missing semantics for imported module ${target.moduleId}`
    );
  }
  registerImportedObjectTemplate({
    dependency,
    dependencySymbol: target.symbol,
    localSymbol: symbol,
    ctx,
  });

  const exportEntry = findExport(target.symbol, dependency);
  if (!exportEntry) {
    throw new Error(
      `module ${target.moduleId} does not export ${expr.path.join("::")}`
    );
  }

  const depCtx = makeDependencyContext(dependency, ctx);
  const depState = createTypingState(state.mode);

  const forward = createTranslation({
    sourceArena: ctx.arena,
    targetArena: depCtx.arena,
    paramMap: new Map(),
    cache: new Map(),
    mapSymbol: (owner) =>
      mapLocalSymbolToDependency({ owner, dependency, ctx }),
  });
  const back = createTranslation({
    sourceArena: depCtx.arena,
    targetArena: ctx.arena,
    paramMap: new Map(),
    cache: new Map(),
    mapSymbol: (owner) =>
      mapDependencySymbolToLocal({ owner, dependency, ctx }),
  });

  const depArgs = typeArgs.map((arg) => forward(arg));
  const resolved =
    resolveImportedAlias(target.symbol, depArgs, depCtx, depState) ??
    resolveImportedObject(target.symbol, depArgs, depCtx, depState) ??
    resolveImportedTrait(target.symbol, depArgs, depCtx, depState);

  return typeof resolved === "number" ? back(resolved) : undefined;
};

const resolveImportedAlias = (
  symbol: SymbolId,
  args: readonly TypeId[],
  ctx: TypingContext,
  state: TypingState
): TypeId | undefined => {
  if (!ctx.typeAliases.hasTemplate(symbol)) {
    return undefined;
  }
  return resolveTypeAlias(symbol, ctx, state, args);
};

const resolveImportedObject = (
  symbol: SymbolId,
  args: readonly TypeId[],
  ctx: TypingContext,
  state: TypingState
): TypeId | undefined => {
  const template = ctx.objects.getTemplate(symbol);
  if (!template) {
    return undefined;
  }
  return ensureObjectType(symbol, ctx, state, args)?.type;
};

const resolveImportedTrait = (
  symbol: SymbolId,
  args: readonly TypeId[],
  ctx: TypingContext,
  state: TypingState
): TypeId | undefined => {
  const decl = ctx.traits.getDecl(symbol);
  if (!decl) {
    return undefined;
  }
  return ensureTraitType(symbol, ctx, state, args);
};

const translateFunctionSignature = ({
  signature,
  translation,
  dependency,
  ctx,
  paramMap,
}: {
  signature: FunctionSignature;
  translation: (id: TypeId) => TypeId;
  dependency: DependencySemantics;
  ctx: TypingContext;
  paramMap: Map<TypeParamId, TypeParamId>;
}): { signature: FunctionSignature } => {
  const typeParamMap = paramMap;
  const params = signature.typeParams?.map((param) => ({
    symbol: cloneTypeParamSymbol(param.symbol, dependency, ctx),
    typeParam: mapTypeParam(param.typeParam, typeParamMap, ctx),
    constraint: param.constraint ? translation(param.constraint) : undefined,
    typeRef: translation(param.typeRef),
  }));

  const parameters = signature.parameters.map((param) => ({
    type: translation(param.type),
    label: param.label,
    bindingKind: param.bindingKind,
    span: param.span,
    name: param.name,
  }));

  const returnType = translation(signature.returnType);
  const typeId = translation(signature.typeId);
  const scheme = ctx.arena.newScheme(
    params?.map((param) => param.typeParam) ?? [],
    typeId
  );

  return {
    signature: {
      typeId,
      parameters,
      returnType,
      hasExplicitReturn: signature.hasExplicitReturn,
      annotatedReturn: signature.annotatedReturn ?? false,
      typeParams: params,
      scheme,
      typeParamMap: signature.typeParamMap,
    },
  };
};

const createTranslation = ({
  sourceArena,
  targetArena,
  paramMap,
  cache,
  mapSymbol,
}: TranslationContext): ((id: TypeId) => TypeId) => {
  const translate = (type: TypeId): TypeId => {
    const cached = cache.get(type);
    if (typeof cached === "number") {
      return cached;
    }

    const desc = sourceArena.get(type);
    let result: TypeId;
    switch (desc.kind) {
      case "primitive":
        result = targetArena.internPrimitive(desc.name);
        break;
      case "type-param-ref": {
        const mapped = mapTypeParam(desc.param, paramMap, { arena: targetArena } as TypingContext);
        result = targetArena.internTypeParamRef(mapped);
        break;
      }
      case "nominal-object": {
        const typeArgs = desc.typeArgs.map(translate);
        result = targetArena.internNominalObject({
          owner: mapSymbol(desc.owner),
          name: desc.name,
          typeArgs,
        });
        break;
      }
      case "trait": {
        const typeArgs = desc.typeArgs.map(translate);
        result = targetArena.internTrait({
          owner: mapSymbol(desc.owner),
          name: desc.name,
          typeArgs,
        });
        break;
      }
      case "structural-object": {
        const mapOwnerSymbol = (
          owner: number | undefined
        ): number | undefined => {
          if (typeof owner !== "number") return owner;
          try {
            return mapSymbol(owner);
          } catch {
            return undefined;
          }
        };
        const fields = desc.fields.map((field) => ({
          name: field.name,
          type: translate(field.type),
          declaringParams: field.declaringParams?.map((param) =>
            mapTypeParam(param, paramMap, { arena: targetArena } as TypingContext)
          ),
          visibility: field.visibility,
          owner: mapOwnerSymbol(field.owner),
          packageId: field.packageId,
        }));
        result = targetArena.internStructuralObject({ fields });
        break;
      }
      case "function": {
        const parameters = desc.parameters.map((param) => ({
          type: translate(param.type),
          label: param.label,
          optional: param.optional,
        }));
        result = targetArena.internFunction({
          parameters,
          returnType: translate(desc.returnType),
          effects: desc.effects,
        });
        break;
      }
      case "union":
        result = targetArena.internUnion(desc.members.map(translate));
        break;
      case "intersection":
        result = targetArena.internIntersection({
          nominal: desc.nominal ? translate(desc.nominal) : undefined,
          structural: desc.structural ? translate(desc.structural) : undefined,
        });
        break;
      case "fixed-array":
        result = targetArena.internFixedArray(translate(desc.element));
        break;
      default:
        throw new Error("unsupported imported type");
    }

    cache.set(type, result);
    return result;
  };

  return translate;
};

const mapTypeParam = (
  source: TypeParamId,
  map: Map<TypeParamId, TypeParamId>,
  ctx: Pick<TypingContext, "arena">
): TypeParamId => {
  const existing = map.get(source);
  if (typeof existing === "number") {
    return existing;
  }
  const fresh = ctx.arena.freshTypeParam();
  map.set(source, fresh);
  return fresh;
};

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
  const template = dependency.typing.objects.getTemplate(dependencySymbol);
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
    params?: readonly TypeParamId[]
  ): readonly TypeParamId[] | undefined => {
    const translated = params
      ?.map(translateTypeParam)
      .filter((entry): entry is TypeParamId => typeof entry === "number");
    return translated && translated.length > 0 ? translated : undefined;
  };

  const params = template.params.map((param) => ({
    symbol: mapParamSymbol(param.symbol),
    typeParam: mapTypeParam(param.typeParam, typeParamMap, ctx),
    constraint: param.constraint
      ? translation(param.constraint)
      : undefined,
  }));

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

const mapDependencySymbolToLocal = ({
  owner,
  dependency,
  ctx,
}: {
  owner: SymbolId;
  dependency: DependencySemantics;
  ctx: TypingContext;
}): SymbolId => {
  const aliases = ctx.importAliasesByModule.get(dependency.moduleId);
  const aliased = aliases?.get(owner);
  if (typeof aliased === "number") {
    return aliased;
  }

  const exportEntry = findExport(owner, dependency);
  if (!exportEntry) {
    throw new Error(`module ${dependency.moduleId} does not export symbol ${owner}`);
  }

  const dependencyRecord = dependency.symbolTable.getSymbol(owner);
  const importableMetadata = importableMetadataFrom(
    dependencyRecord.metadata as Record<string, unknown> | undefined
  );
  const declared = ctx.symbolTable.declare({
    name: exportEntry.name,
    kind: exportEntry.kind,
    declaredAt: ctx.hir.module.ast,
    metadata: {
      import: { moduleId: dependency.moduleId, symbol: owner },
      ...(importableMetadata ?? {}),
    },
  });
  ctx.importsByLocal.set(declared, { moduleId: dependency.moduleId, symbol: owner });
  const bucket = ctx.importAliasesByModule.get(dependency.moduleId) ?? new Map();
  bucket.set(owner, declared);
  ctx.importAliasesByModule.set(dependency.moduleId, bucket);
  if (
    exportEntry.kind === "type" ||
    dependency.typing.objects.getTemplate(owner)
  ) {
    registerImportedObjectTemplate({
      dependency,
      dependencySymbol: owner,
      localSymbol: declared,
      ctx,
    });
  }
  return declared;
};

const mapLocalSymbolToDependency = ({
  owner,
  dependency,
  ctx,
}: {
  owner: SymbolId;
  dependency: DependencySemantics;
  ctx: TypingContext;
}): SymbolId => {
  const record = ctx.symbolTable.getSymbol(owner);
  const metadata = (record.metadata ?? {}) as {
    import?: { moduleId: string; symbol: SymbolId };
  };
  if (metadata.import && metadata.import.moduleId === dependency.moduleId) {
    return metadata.import.symbol;
  }

  throw new Error(
    `type parameter or symbol ${record.name} is not available in ${dependency.moduleId}`
  );
};

const findExport = (
  symbol: SymbolId,
  dependency: DependencySemantics
): ModuleExportEntry | undefined =>
  Array.from(dependency.exports.values()).find(
    (entry) =>
      entry.symbol === symbol || entry.symbols?.some((sym) => sym === symbol)
  );

const makeDependencyContext = (
  dependency: DependencySemantics,
  ctx: TypingContext
): TypingContext => ({
  symbolTable: dependency.symbolTable,
  hir: dependency.hir,
  overloads: dependency.overloads,
  decls: dependency.decls,
  moduleId: dependency.moduleId,
  packageId: dependency.packageId,
  moduleExports: ctx.moduleExports,
  dependencies: ctx.dependencies,
  importsByLocal: new Map(),
  importAliasesByModule: new Map(),
  arena: dependency.typing.arena,
  table: dependency.typing.table,
  resolvedExprTypes: new Map(dependency.typing.resolvedExprTypes),
  valueTypes: new Map(dependency.typing.valueTypes),
  callResolution: {
    targets: new Map(
      Array.from(dependency.typing.callTargets.entries()).map(
        ([exprId, targets]) => [exprId, new Map(targets)]
      )
    ),
    typeArguments: new Map(dependency.typing.callTypeArguments),
    instanceKeys: new Map(dependency.typing.callInstanceKeys),
    traitDispatches: new Set(dependency.typing.callTraitDispatches),
  },
  functions: dependency.typing.functions,
  objects: dependency.typing.objects,
  traits: dependency.typing.traits,
  typeAliases: dependency.typing.typeAliases,
  primitives: dependency.typing.primitives,
  intrinsicTypes: dependency.typing.intrinsicTypes,
  traitImplsByNominal: new Map(dependency.typing.traitImplsByNominal),
  traitImplsByTrait: new Map(dependency.typing.traitImplsByTrait),
  traitMethodImpls: new Map(dependency.typing.traitMethodImpls),
  memberMetadata: new Map(dependency.typing.memberMetadata),
  diagnostics: new DiagnosticEmitter(),
});

const cloneTypeParamSymbol = (
  symbol: SymbolId,
  dependency: DependencySemantics,
  ctx: TypingContext
): SymbolId => {
  const name = dependency.symbolTable.getSymbol(symbol).name;
  return ctx.symbolTable.declare({
    name,
    kind: "type-parameter",
    declaredAt: ctx.hir.module.ast,
  });
};
