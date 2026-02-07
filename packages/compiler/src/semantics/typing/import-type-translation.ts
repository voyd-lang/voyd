import type {
  DependencySemantics,
  FunctionSignature,
  TypingContext,
} from "./types.js";
import type {
  EffectRowId,
  SymbolId,
  TypeId,
  TypeParamId,
} from "../ids.js";
import type { EffectTable } from "../effects/effect-table.js";
import {
  effectsShareInterner,
  typingContextsShareInterners,
} from "./shared-interners.js";

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
  if (effectsShareInterner(sourceEffects, targetEffects)) {
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
  typingContextsShareInterners({
    sourceArena,
    targetArena,
    sourceEffects,
    targetEffects,
  })
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

export const translateFunctionSignature = ({
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
    typeId,
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

export const createTranslation = ({
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
          owner: number | undefined,
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
            mapTypeParam(param, paramMap, { arena: targetArena }),
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

export const mapTypeParam = (
  source: TypeParamId,
  map: Map<TypeParamId, TypeParamId>,
  ctx: Pick<TypingContext, "arena">,
): TypeParamId => {
  const existing = map.get(source);
  if (typeof existing === "number") {
    return existing;
  }
  const fresh = ctx.arena.freshTypeParam();
  map.set(source, fresh);
  return fresh;
};

const cloneTypeParamSymbol = (
  symbol: SymbolId,
  dependency: DependencySemantics,
  ctx: TypingContext,
): SymbolId => {
  const name = dependency.symbolTable.getSymbol(symbol).name;
  return ctx.symbolTable.declare({
    name,
    kind: "type-parameter",
    declaredAt: ctx.hir.module.ast,
  });
};
