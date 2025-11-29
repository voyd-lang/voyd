import { createTypingState } from "./context.js";
import {
  ensureObjectType,
  ensureTraitType,
  resolveTypeAlias,
} from "./type-system.js";
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

const copyIntrinsicMetadata = ({
  localSymbol,
  dependencySymbol,
  dependency,
  ctx,
}: {
  localSymbol: SymbolId;
  dependencySymbol: SymbolId;
  dependency: DependencySemantics;
  ctx: TypingContext;
}): void => {
  const sourceRecord = dependency.symbolTable.getSymbol(dependencySymbol);
  const metadata = (sourceRecord.metadata ?? {}) as {
    intrinsic?: boolean;
    intrinsicName?: string;
    intrinsicUsesSignature?: boolean;
  };
  if (!metadata.intrinsic) {
    return;
  }
  ctx.symbolTable.setSymbolMetadata(localSymbol, metadata);
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
  copyIntrinsicMetadata({
    localSymbol: symbol,
    dependencySymbol: target.symbol,
    dependency,
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
        const fields = desc.fields.map((field) => ({
          name: field.name,
          type: translate(field.type),
          declaringParams: field.declaringParams?.map((param) =>
            mapTypeParam(param, paramMap, { arena: targetArena } as TypingContext)
          ),
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

  const declared = ctx.symbolTable.declare({
    name: exportEntry.name,
    kind: exportEntry.kind,
    declaredAt: ctx.hir.module.ast,
    metadata: { import: { moduleId: dependency.moduleId, symbol: owner } },
  });
  ctx.importsByLocal.set(declared, { moduleId: dependency.moduleId, symbol: owner });
  const bucket = ctx.importAliasesByModule.get(dependency.moduleId) ?? new Map();
  bucket.set(owner, declared);
  ctx.importAliasesByModule.set(dependency.moduleId, bucket);
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
    (entry) => entry.symbol === symbol
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
  },
  functions: dependency.typing.functions,
  objects: dependency.typing.objects,
  traits: dependency.typing.traits,
  typeAliases: dependency.typing.typeAliases,
  primitives: dependency.typing.primitives,
  intrinsicTypes: dependency.typing.intrinsicTypes,
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
