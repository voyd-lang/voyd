import { createTypingState } from "./context.js";
import {
  ensureObjectType,
  ensureTraitType,
  getObjectTemplate,
  resolveTypeAlias,
} from "./type-system.js";
import { cloneNestedMap } from "./call-resolution.js";
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
  EffectRowId,
  SymbolId,
  TypeId,
  TypeParamId,
  TypeSchemeId,
} from "../ids.js";
import type { ModuleExportEntry } from "../modules.js";
import type { EffectTable } from "../effects/effect-table.js";
import { symbolRefKey, type SymbolRef } from "./symbol-ref.js";

type ImportTarget = { moduleId: string; symbol: SymbolId };

type TranslationContext = {
  sourceArena: TypingContext["arena"];
  targetArena: TypingContext["arena"];
  sourceEffects: EffectTable;
  targetEffects: EffectTable;
  paramMap: Map<TypeParamId, TypeParamId>;
  cache: Map<TypeId, TypeId>;
  mapSymbol: (symbol: SymbolId) => SymbolId;
};

const translateEffectRow = ({
  effectRow,
  sourceEffects,
  targetEffects,
}: {
  effectRow: EffectRowId;
  sourceEffects: EffectTable;
  targetEffects: EffectTable;
}): EffectRowId => {
  if (sourceEffects === targetEffects) {
    return effectRow;
  }
  if (effectRow === sourceEffects.emptyRow) {
    return targetEffects.emptyRow;
  }
  if (effectRow === sourceEffects.unknownRow) {
    return targetEffects.unknownRow;
  }
  const desc = sourceEffects.getRow(effectRow);
  const tailVar = desc.tailVar
    ? targetEffects.freshTailVar({ rigid: desc.tailVar.rigid })
    : undefined;
  return targetEffects.internRow({
    operations: desc.operations.map((op) => ({
      name: op.name,
      ...(typeof op.region === "number" ? { region: op.region } : {}),
    })),
    tailVar,
  });
};

export const createTypeTranslation = ({
  sourceArena,
  targetArena,
  sourceEffects,
  targetEffects,
  mapSymbol,
}: {
  sourceArena: TypingContext["arena"];
  targetArena: TypingContext["arena"];
  sourceEffects: EffectTable;
  targetEffects: EffectTable;
  mapSymbol: (symbol: SymbolId) => SymbolId;
}): ((id: TypeId) => TypeId) =>
  sourceArena === targetArena && sourceEffects === targetEffects
    ? (id) => id
    : createTranslation({
        sourceArena,
        targetArena,
        sourceEffects,
        targetEffects,
        paramMap: new Map<TypeParamId, TypeParamId>(),
        cache: new Map<TypeId, TypeId>(),
        mapSymbol,
      });

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

  const sharedInterners =
    dependency.typing.arena === ctx.arena && dependency.typing.effects === ctx.effects;

  if (sharedInterners) {
    const scheme = dependency.typing.table.getSymbolScheme(target.symbol);
    if (typeof scheme === "number") {
      ctx.table.setSymbolScheme(symbol, scheme);
      const sourceScheme = ctx.arena.getScheme(scheme);
      ctx.valueTypes.set(symbol, sourceScheme.body);
      ensureImportedOwnerTemplatesAvailable({
        types: [sourceScheme.body],
        ctx,
      });
    }

    const signature = dependency.typing.functions.getSignature(target.symbol);
    if (signature) {
      ctx.functions.setSignature(symbol, signature);
      ctx.table.setSymbolScheme(symbol, signature.scheme);
      ctx.valueTypes.set(symbol, signature.typeId);
      ensureImportedOwnerTemplatesAvailable({
        types: [
          signature.typeId,
          signature.returnType,
          ...signature.parameters.map((param) => param.type),
        ],
        ctx,
      });
    }

    const resolvedType = ctx.valueTypes.get(symbol);
    return typeof resolvedType === "number" ? { type: resolvedType, scheme: ctx.table.getSymbolScheme(symbol) } : undefined;
  }

  const paramMap = new Map<TypeParamId, TypeParamId>();
  const cache = new Map<TypeId, TypeId>();
  const translation = createTranslation({
    sourceArena: dependency.typing.arena,
    targetArena: ctx.arena,
    sourceEffects: dependency.typing.effects,
    targetEffects: ctx.effects,
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
    ensureImportedOwnerTemplatesAvailable({
      types: [
        translated.signature.typeId,
        translated.signature.returnType,
        ...translated.signature.parameters.map((param) => param.type),
      ],
      ctx,
    });
    return { type: translated.signature.typeId, scheme };
  }

  if (typeof scheme === "number") {
    return { type: ctx.arena.getScheme(scheme).body, scheme };
  }

  return undefined;
};

const ensureImportedOwnerTemplatesAvailable = ({
  types,
  ctx,
}: {
  types: readonly TypeId[];
  ctx: TypingContext;
}): void => {
  const owners: SymbolRef[] = [];
  const seenTypes = new Set<TypeId>();
  const seenOwners = new Set<string>();

  types.forEach((type) => collectOwnerRefs(type, ctx.arena, owners, seenTypes, seenOwners));

  owners.forEach((owner) => {
    if (owner.moduleId === ctx.moduleId) {
      return;
    }
    const dependency = ctx.dependencies.get(owner.moduleId);
    if (!dependency) {
      return;
    }
    const localSymbol = mapDependencySymbolToLocal({
      owner: owner.symbol,
      dependency,
      ctx,
      allowUnexported: true,
    });
    registerImportedObjectTemplate({
      dependency,
      dependencySymbol: owner.symbol,
      localSymbol,
      ctx,
    });
  });
};

const collectOwnerRefs = (
  root: TypeId,
  arena: TypingContext["arena"],
  owners: SymbolRef[],
  seenTypes: Set<TypeId>,
  seenOwners: Set<string>
): void => {
  const stack: TypeId[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current !== "number") {
      continue;
    }
    if (seenTypes.has(current)) {
      continue;
    }
    seenTypes.add(current);
    const desc = arena.get(current);
    switch (desc.kind) {
      case "nominal-object":
      case "trait": {
        const ownerKey = symbolRefKey(desc.owner);
        if (!seenOwners.has(ownerKey)) {
          seenOwners.add(ownerKey);
          owners.push(desc.owner);
        }
        desc.typeArgs.forEach((arg) => stack.push(arg));
        break;
      }
      case "structural-object":
        desc.fields.forEach((field) => stack.push(field.type));
        break;
      case "function":
        desc.parameters.forEach((param) => stack.push(param.type));
        stack.push(desc.returnType);
        break;
      case "union":
        desc.members.forEach((member) => stack.push(member));
        break;
      case "intersection":
        if (typeof desc.nominal === "number") stack.push(desc.nominal);
        if (typeof desc.structural === "number") stack.push(desc.structural);
        break;
      case "fixed-array":
        stack.push(desc.element);
        break;
      default:
        break;
    }
  }
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

  const sharedArena = depCtx.arena === ctx.arena;
  const sharedEffects = depCtx.effects.internRow === ctx.effects.internRow;
  if (sharedArena && sharedEffects) {
    const aliasResolved = resolveImportedAlias(target.symbol, typeArgs, depCtx, depState);
    const resolved =
      aliasResolved ??
      resolveImportedObject(target.symbol, typeArgs, depCtx, depState) ??
      resolveImportedTrait(target.symbol, typeArgs, depCtx, depState);
    if (typeof aliasResolved === "number") {
      ctx.typeAliases.recordInstanceSymbol(aliasResolved, symbol);
    }
    return resolved;
  }

  const forwardParamMap = new Map<TypeParamId, TypeParamId>();
  const forward = createTranslation({
    sourceArena: ctx.arena,
    targetArena: depCtx.arena,
    sourceEffects: ctx.effects,
    targetEffects: depCtx.effects,
    paramMap: forwardParamMap,
    cache: new Map(),
    mapSymbol: (owner) =>
      mapLocalSymbolToDependency({ owner, dependency, ctx }),
  });
  const reverseParamMap = new Map<TypeParamId, TypeParamId>();
  const back = createTranslation({
    sourceArena: depCtx.arena,
    targetArena: ctx.arena,
    sourceEffects: depCtx.effects,
    targetEffects: ctx.effects,
    paramMap: reverseParamMap,
    cache: new Map(),
    mapSymbol: (owner) =>
      mapDependencySymbolToLocal({ owner, dependency, ctx }),
  });

  const depArgs = typeArgs.map((arg) => forward(arg));
  forwardParamMap.forEach((targetParam, sourceParam) => {
    reverseParamMap.set(targetParam, sourceParam);
  });
  const aliasResolved = resolveImportedAlias(target.symbol, depArgs, depCtx, depState);
  const resolved =
    aliasResolved ??
    resolveImportedObject(target.symbol, depArgs, depCtx, depState) ??
    resolveImportedTrait(target.symbol, depArgs, depCtx, depState);

  const localType = typeof resolved === "number" ? back(resolved) : undefined;
  if (typeof aliasResolved === "number" && typeof localType === "number") {
    ctx.typeAliases.recordInstanceSymbol(localType, symbol);
  }
  return localType;
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
      effectRow: translateEffectRow({
        effectRow: signature.effectRow,
        sourceEffects: dependency.typing.effects,
        targetEffects: ctx.effects,
      }),
      annotatedEffects: signature.annotatedEffects ?? false,
      typeParams: params,
      scheme,
      typeParamMap: signature.typeParamMap,
    },
  };
};

const createTranslation = ({
  sourceArena,
  targetArena,
  sourceEffects,
  targetEffects,
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
        const mapped = mapTypeParam(desc.param, paramMap, { arena: targetArena });
        result = targetArena.internTypeParamRef(mapped);
        break;
      }
      case "recursive": {
        result = targetArena.createRecursiveType((self, _placeholder) => {
          cache.set(type, self);
          const translateWithSelf = (inner: TypeId): TypeId => {
            const innerDesc = sourceArena.get(inner);
            if (
              innerDesc.kind === "type-param-ref" &&
              innerDesc.param === desc.binder
            ) {
              return self;
            }
            return translate(inner);
          };
          const translated = translateWithSelf(desc.body);
          return targetArena.get(translated);
        });
        break;
      }
      case "nominal-object": {
        const typeArgs = desc.typeArgs.map(translate);
        result = targetArena.internNominalObject({
          owner: desc.owner,
          name: desc.name,
          typeArgs,
        });
        break;
      }
      case "trait": {
        const typeArgs = desc.typeArgs.map(translate);
        result = targetArena.internTrait({
          owner: desc.owner,
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
            mapTypeParam(param, paramMap, { arena: targetArena })
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
          effectRow: translateEffectRow({
            effectRow: desc.effectRow,
            sourceEffects,
            targetEffects,
          }),
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
          traits: desc.traits ? desc.traits.map(translate) : undefined,
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
    seen: Set<string>
  ): SymbolId => {
    const key = `${candidateDependency.moduleId}::${candidateOwner}`;
    if (seen.has(key)) {
      throw new Error(
        `cyclic import metadata while resolving symbol ${candidateOwner}`
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
          record.metadata as Record<string, unknown> | undefined
        );
        const declared = ctx.symbolTable.declare({
          name: recordName,
          kind: record.kind,
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
        `module ${candidateDependency.moduleId} does not export symbol ${candidateOwner}`
      );
    }

    const dependencyRecord = candidateDependency.symbolTable.getSymbol(
      candidateOwner
    );
  const importableMetadata = importableMetadataFrom(
    dependencyRecord.metadata as Record<string, unknown> | undefined
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
  activeValueTypeComputations: new Set(),
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
  effects: dependency.typing.effects,
  resolvedExprTypes: new Map(dependency.typing.resolvedExprTypes),
  valueTypes: new Map(dependency.typing.valueTypes),
  tailResumptions: new Map(dependency.typing.tailResumptions),
  callResolution: {
    targets: cloneNestedMap(dependency.typing.callTargets),
    typeArguments: cloneNestedMap(dependency.typing.callTypeArguments),
    instanceKeys: cloneNestedMap(dependency.typing.callInstanceKeys),
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
