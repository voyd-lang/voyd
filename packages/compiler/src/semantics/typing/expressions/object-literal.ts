import type {
  HirNamedTypeExpr,
  HirObjectLiteralEntry,
  HirObjectLiteralExpr,
} from "../../hir/index.js";
import type {
  SourceSpan,
  SymbolId,
  TypeId,
  TypeParamId,
} from "../../ids.js";
import { typeExpression, withSpeculativeExprTyping } from "../expressions.js";
import { composeEffectRows, getExprEffectRow } from "../effects.js";
import {
  ensureObjectType,
  ensureTypeMatches,
  getNominalComponent,
  getObjectTemplate,
  getStructuralFields,
  getSymbolName,
  resolveTypeAlias,
  resolveTypeExpr,
  typeSatisfies,
  unifyWithBudget,
} from "../type-system.js";
import { localSymbolForSymbolRef } from "../symbol-ref-utils.js";
import {
  resolveImportedAliasInferenceTarget,
  resolveImportedTypeExpr,
} from "../imports.js";
import { bindTypeParams as bindTypeParamsFromType } from "../type-relations.js";
import { typeDescriptorToUserString } from "../type-arena.js";
import type { ObjectField, TypingContext, TypingState } from "../types.js";
import {
  assertFieldAccess,
  canAccessField,
  filterAccessibleFields,
  reportInaccessibleFieldRequirement,
} from "../visibility.js";
import { emitDiagnostic, normalizeSpan } from "../../../diagnostics/index.js";
import { nominalTypeTargetTypeArgumentsFromMetadata } from "../../nominal-type-target.js";

type StructuralLiteralField = Pick<ObjectField, "name" | "type" | "optional">;

type FieldwiseAliasResolution = {
  aliasSymbol: SymbolId;
  namedTarget: HirNamedTypeExpr;
  target: TypeId;
  appliedArgs: readonly TypeId[];
  inferenceParams: readonly TypeParamId[];
  unresolvedSubstitution: ReadonlyMap<TypeParamId, TypeId>;
};

export const typeObjectLiteralExpr = (
  expr: HirObjectLiteralExpr,
  ctx: TypingContext,
  state: TypingState,
  expectedType?: TypeId,
): TypeId => {
  if (expr.literalKind === "nominal") {
    return typeNominalObjectLiteral(expr, ctx, state, expectedType);
  }

  const expectedFields =
    typeof expectedType === "number" && expectedType !== ctx.primitives.unknown
      ? new Map(
          (getStructuralFields(expectedType, ctx, state) ?? []).map((field) => [
            field.name,
            field,
          ]),
        )
      : undefined;
  const fields = new Map<string, StructuralLiteralField>();
  expr.entries.forEach((entry) =>
    mergeObjectLiteralEntry(entry, fields, ctx, state, expectedFields),
  );

  expectedFields?.forEach((field) => {
    if (field.optional && !fields.has(field.name)) {
      fields.set(field.name, {
        name: field.name,
        type: field.type,
        optional: true,
      });
    }
  });

  const orderedFields = Array.from(fields.values());
  const effectRow = composeEffectRows(
    ctx.effects,
    expr.entries.map((entry) => getExprEffectRow(entry.value, ctx)),
  );
  ctx.effects.setExprEffect(expr.id, effectRow);
  return ctx.arena.internStructuralObject({ fields: orderedFields });
};

const mergeObjectLiteralEntry = (
  entry: HirObjectLiteralEntry,
  fields: Map<string, StructuralLiteralField>,
  ctx: TypingContext,
  state: TypingState,
  expectedFields?: ReadonlyMap<string, ObjectField>,
): void => {
  if (entry.kind === "field") {
    const expectedField = expectedFields?.get(entry.name);
    const valueType = typeExpression(entry.value, ctx, state, {
      expectedType: expectedField?.type,
    });
    fields.set(
      entry.name,
      structuralLiteralFieldForValue({
        name: entry.name,
        valueType,
        expectedField,
        ctx,
        state,
      }),
    );
    return;
  }

  const spreadFields = resolveAccessibleObjectSpreadFields({
    entry,
    ctx,
    state,
  });
  if (!spreadFields) {
    return;
  }

  spreadFields.forEach((field) => {
    const expectedField = expectedFields?.get(field.name);
    fields.set(
      field.name,
      structuralLiteralFieldForValue({
        name: field.name,
        valueType: field.type,
        expectedField,
        fallbackOptional: field.optional,
        ctx,
        state,
      }),
    );
  });
};

const structuralLiteralFieldForValue = ({
  name,
  valueType,
  expectedField,
  fallbackOptional,
  ctx,
  state,
}: {
  name: string;
  valueType: TypeId;
  expectedField: ObjectField | undefined;
  fallbackOptional?: boolean;
  ctx: TypingContext;
  state: TypingState;
}): StructuralLiteralField => {
  if (
    expectedField?.optional &&
    typeSatisfies(valueType, expectedField.type, ctx, state)
  ) {
    return {
      name,
      type: expectedField.type,
      optional: true,
    };
  }

  return {
    name,
    type: valueType,
    optional: fallbackOptional ? true : undefined,
  };
};

const resolveFieldwiseAliasTarget = ({
  namedTarget,
  aliasSymbol,
  ctx,
  state,
}: {
  namedTarget: HirNamedTypeExpr;
  aliasSymbol: SymbolId;
  ctx: TypingContext;
  state: TypingState;
}): FieldwiseAliasResolution => {
  const explicitArgs =
    namedTarget.typeArguments?.map((arg) =>
      resolveTypeExpr(arg, ctx, state, ctx.primitives.unknown),
    ) ?? [];
  const localTemplate = ctx.typeAliases.getTemplate(aliasSymbol);
  const metadata = nominalTypeTargetTypeArgumentsFromMetadata({
    source: ctx.symbolTable.getSymbol(aliasSymbol).metadata,
  });
  const knownParamCount = localTemplate
    ? localTemplate.params.length
    : metadata?.typeParameterNames.length;
  const paramCount = knownParamCount ?? explicitArgs.length;
  const inferenceParams = Array.from(
    { length: Math.max(0, paramCount - explicitArgs.length) },
    () => ctx.arena.freshTypeParam(),
  );
  const appliedArgs = Array.from(
    { length: Math.max(paramCount, explicitArgs.length) },
    (_, index) => {
      const explicit = explicitArgs[index];
      if (typeof explicit === "number") {
        return explicit;
      }
      const inference = inferenceParams[index - explicitArgs.length]!;
      return ctx.arena.internTypeParamRef(inference);
    },
  );
  if (localTemplate && inferenceParams.length > 0) {
    const typeParamMap = new Map(
      localTemplate.params.map((param, index) => [
        param.symbol,
        appliedArgs[index]!,
      ]),
    );
    localTemplate.params.forEach((param, index) => {
      const inference = inferenceParams[index - explicitArgs.length];
      if (!param.constraint || typeof inference !== "number") {
        return;
      }
      const constraint = resolveTypeExpr(
        param.constraint,
        ctx,
        state,
        ctx.primitives.unknown,
        typeParamMap,
      );
      ctx.typeParameterConstraints.set(inference, constraint);
    });
  }
  const target =
    !localTemplate && inferenceParams.length > 0
      ? resolveImportedAliasInferenceTarget({
          expr: namedTarget,
          typeArgs: appliedArgs,
          ctx,
          state,
        })
      : resolveFieldwiseAliasWithArguments({
          namedTarget,
          aliasSymbol,
          typeArgs: appliedArgs,
          ctx,
          state,
        });
  if (typeof target !== "number") {
    throw new Error("missing type alias inference target");
  }
  return {
    aliasSymbol,
    namedTarget,
    target,
    appliedArgs,
    inferenceParams,
    unresolvedSubstitution: new Map(
      inferenceParams.map((param) => [param, ctx.primitives.unknown]),
    ),
  };
};

const resolveFieldwiseAliasWithArguments = ({
  namedTarget,
  aliasSymbol,
  typeArgs,
  ctx,
  state,
}: {
  namedTarget: HirNamedTypeExpr;
  aliasSymbol: SymbolId;
  typeArgs: readonly TypeId[];
  ctx: TypingContext;
  state: TypingState;
}): TypeId => {
  const relaxedState =
    state.mode === "relaxed" ? state : { ...state, mode: "relaxed" as const };
  if (ctx.typeAliases.hasTemplate(aliasSymbol)) {
    return resolveTypeAlias(aliasSymbol, ctx, relaxedState, typeArgs);
  }
  const imported = resolveImportedTypeExpr({
    expr: namedTarget,
    typeArgs,
    ctx,
    state: relaxedState,
  });
  if (typeof imported !== "number") {
    throw new Error("missing imported type alias target");
  }
  return imported;
};

const typeNominalObjectLiteral = (
  expr: HirObjectLiteralExpr,
  ctx: TypingContext,
  state: TypingState,
  expectedType?: TypeId,
): TypeId => {
  const namedTarget =
    expr.target?.typeKind === "named" ? expr.target : undefined;
  const declaredTargetSymbol =
    expr.targetSymbol ??
    namedTarget?.symbol ??
    (namedTarget ? ctx.objects.resolveName(namedTarget.path[0]!) : undefined);
  const declaredTargetRecord =
    typeof declaredTargetSymbol === "number"
      ? ctx.symbolTable.getSymbol(declaredTargetSymbol)
      : undefined;
  const isAliasTarget =
    (declaredTargetRecord?.metadata as { entity?: unknown } | undefined)
      ?.entity === "type-alias";
  const aliasResolution =
    namedTarget && isAliasTarget && typeof declaredTargetSymbol === "number"
      ? resolveFieldwiseAliasTarget({
          namedTarget,
          aliasSymbol: declaredTargetSymbol,
          ctx,
          state,
        })
      : undefined;
  const resolvedTarget = aliasResolution?.target;
  const nominalTarget =
    typeof resolvedTarget === "number"
      ? getNominalComponent(resolvedTarget, ctx)
      : undefined;
  const nominalTargetDesc =
    typeof nominalTarget === "number" ? ctx.arena.get(nominalTarget) : undefined;
  const resolvedTargetSymbol =
    nominalTargetDesc?.kind === "nominal-object" ||
    nominalTargetDesc?.kind === "value-object"
      ? localSymbolForSymbolRef(nominalTargetDesc.owner, ctx)
      : undefined;
  const targetSymbol =
    resolvedTargetSymbol ??
    declaredTargetSymbol;
  if (typeof targetSymbol !== "number") {
    throw new Error("nominal object literal missing target type");
  }

  if (
    isAliasTarget &&
    typeof resolvedTarget === "number" &&
    resolvedTarget !== ctx.primitives.unknown &&
    typeof nominalTarget !== "number"
  ) {
    const targetName = namedTarget?.path.at(-1) ?? getSymbolName(targetSymbol, ctx);
    return emitDiagnostic({
      ctx,
      code: "TY0041",
      params: {
        kind: "symbol-not-a-value",
        name: targetName,
        symbolKind: "type",
      },
      span: normalizeSpan(expr.span),
    });
  }

  const template = getObjectTemplate(targetSymbol, ctx, state);
  if (!template) {
    throw new Error("missing object template for nominal literal");
  }

  const typeName = getSymbolName(targetSymbol, ctx);
  const templateFields = new Map<string, ObjectField>(
    template.fields.map((field) => [field.name, field]),
  );
  const explicitTypeArgs =
    isAliasTarget &&
    (nominalTargetDesc?.kind === "nominal-object" ||
      nominalTargetDesc?.kind === "value-object")
      ? nominalTargetDesc.typeArgs
      : (namedTarget?.typeArguments?.map((arg) =>
          resolveTypeExpr(arg, ctx, state, ctx.primitives.unknown),
        ) ?? []);
  const typeParamBindings = new Map<TypeParamId, TypeId>();
  const expectedTypeArgs = expectedNominalTypeArgsForTarget({
    expectedType,
    targetSymbol,
    ctx,
  });
  const hasExplicitTypeArgsForAllParams =
    (aliasResolution?.inferenceParams.length ?? 0) === 0 &&
    template.params.length > 0 &&
    template.params.every(
      (_, index) =>
        typeof explicitTypeArgs[index] === "number" &&
        explicitTypeArgs[index] !== ctx.primitives.unknown,
    );

  if (!hasExplicitTypeArgsForAllParams) {
    withSpeculativeExprTyping(ctx, () => {
      expr.entries.forEach((entry) =>
        bindNominalObjectEntry({
          entry,
          declared: templateFields,
          bindings: typeParamBindings,
          ctx,
          state,
          typeName,
        }),
      );
    });
  }

  const typeArgumentCount =
    expr.nominalConstruction === "fieldwise-call"
      ? Math.max(template.params.length, explicitTypeArgs.length)
      : template.params.length;
  const typeArgs = Array.from(
    { length: typeArgumentCount },
    (_, index) => {
      const param = template.params[index];
      const explicit = explicitTypeArgs[index];
      const needsAliasInference =
        typeof explicit === "number" &&
        aliasResolution?.unresolvedSubstitution &&
        ctx.arena.substitute(
          explicit,
          aliasResolution.unresolvedSubstitution,
        ) !== explicit;
      if (typeof explicit === "number" && !needsAliasInference) {
        return explicit;
      }
      const inferred = param
        ? typeParamBindings.get(param.typeParam)
        : undefined;
      return inferred ?? expectedTypeArgs?.[index] ?? ctx.primitives.unknown;
    },
  );

  const objectInfo = ensureObjectType(targetSymbol, ctx, state, typeArgs);
  if (!objectInfo) {
    throw new Error("missing object type information for nominal literal");
  }

  const declaredFields = new Map<string, ObjectField>(
    objectInfo.fields.map((field) => [field.name, field]),
  );
  const provided = new Set<string>();

  expr.entries.forEach((entry) =>
    mergeNominalObjectEntry({
      entry,
      declared: declaredFields,
      provided,
      ctx,
      state,
      typeName,
    }),
  );

  declaredFields.forEach((field, name) => {
    if (!provided.has(name)) {
      const accessible = canAccessField(field, ctx, state, {
        allowOwnerPrivate: true,
      });
      if (!accessible) {
        reportInaccessibleFieldRequirement({
          field,
          typeName,
          ctx,
          state,
          span: expr.span,
        });
        return;
      }
      if (field.optional) {
        return;
      }
      emitMissingObjectFieldDiagnostic({
        field: name,
        receiver: typeName,
        span: expr.span,
        ctx,
      });
    }
  });

  const effectRow = composeEffectRows(
    ctx.effects,
    expr.entries.map((entry) => getExprEffectRow(entry.value, ctx)),
  );
  ctx.effects.setExprEffect(expr.id, effectRow);
  if (!aliasResolution || aliasResolution.inferenceParams.length === 0) {
    return objectInfo.type;
  }

  const unified = unifyWithBudget({
    actual: objectInfo.type,
    expected: resolvedTarget!,
    options: {
      location: expr.ast,
      reason: "fieldwise alias construction",
      allowUnknown: true,
    },
    ctx,
    span: normalizeSpan(expr.span),
  });
  if (!unified.ok) {
    return emitDiagnostic({
      ctx,
      code: "TY0027",
      params: {
        kind: "type-mismatch",
        actual: typeDescriptorToUserString(
          ctx.arena.get(objectInfo.type),
          ctx.arena,
        ),
        expected: typeDescriptorToUserString(
          ctx.arena.get(resolvedTarget!),
          ctx.arena,
        ),
      },
      span: normalizeSpan(expr.span),
    });
  }

  const inferredAliasArgs = aliasResolution.appliedArgs.map((arg) =>
    ctx.arena.substitute(arg, unified.substitution),
  );
  const hasUnresolvedAliasArg = inferredAliasArgs.some(
    (arg) =>
      ctx.arena.substitute(arg, aliasResolution.unresolvedSubstitution) !== arg,
  );
  if (hasUnresolvedAliasArg) {
    const unresolvedCount = inferredAliasArgs.filter(
      (arg) =>
        ctx.arena.substitute(arg, aliasResolution.unresolvedSubstitution) !==
        arg,
    ).length;
    throw new Error(
      `type alias ${ctx.symbolTable.getSymbol(aliasResolution.aliasSymbol).name} is missing ${unresolvedCount} type argument(s)`,
    );
  }

  resolveFieldwiseAliasWithArguments({
    namedTarget: aliasResolution.namedTarget,
    aliasSymbol: aliasResolution.aliasSymbol,
    typeArgs: inferredAliasArgs,
    ctx,
    state,
  });
  return objectInfo.type;
};

const expectedNominalTypeArgsForTarget = ({
  expectedType,
  targetSymbol,
  ctx,
}: {
  expectedType?: TypeId;
  targetSymbol: SymbolId;
  ctx: TypingContext;
}): readonly TypeId[] | undefined => {
  if (
    typeof expectedType !== "number" ||
    expectedType === ctx.primitives.unknown
  ) {
    return undefined;
  }
  const expectedDesc = ctx.arena.get(expectedType);
  const members = expectedDesc.kind === "union" ? expectedDesc.members : [expectedType];
  const candidates = members.flatMap((member) => {
    const nominal = getNominalComponent(member, ctx);
    if (typeof nominal !== "number") {
      return [];
    }
    const desc = ctx.arena.get(nominal);
    if (desc.kind !== "nominal-object" && desc.kind !== "value-object") {
      return [];
    }
    return localSymbolForSymbolRef(desc.owner, ctx) === targetSymbol
      ? [desc.typeArgs]
      : [];
  });
  return candidates.length === 1 ? candidates[0] : undefined;
};

const bindNominalObjectEntry = ({
  entry,
  declared,
  bindings,
  ctx,
  state,
  typeName,
}: {
  entry: HirObjectLiteralEntry;
  declared: Map<string, ObjectField>;
  bindings: Map<TypeParamId, TypeId>;
  ctx: TypingContext;
  state: TypingState;
  typeName: string;
}): void =>
  forEachNominalObjectEntryField({
    entry,
    declared,
    ctx,
    state,
    typeName,
    onField: ({ expectedField, valueType }) => {
      bindTypeParamsFromType(
        expectedField.type,
        valueType,
        bindings,
        ctx,
        state,
      );
    },
  });

const mergeNominalObjectEntry = ({
  entry,
  declared,
  provided,
  ctx,
  state,
  typeName,
}: {
  entry: HirObjectLiteralEntry;
  declared: Map<string, ObjectField>;
  provided: Set<string>;
  ctx: TypingContext;
  state: TypingState;
  typeName: string;
}): void =>
  forEachNominalObjectEntryField({
    entry,
    declared,
    ctx,
    state,
    typeName,
    onField: ({ fieldSpan, name, expectedField, valueType, isSpread }) => {
      if (expectedField.type !== ctx.primitives.unknown) {
        ensureTypeMatches(
          valueType,
          expectedField.type,
          ctx,
          state,
          isSpread ? `spread field ${name}` : `field ${name}`,
          fieldSpan,
        );
      }
      provided.add(name);
    },
  });

type NominalObjectEntryField = {
  fieldSpan: SourceSpan;
  name: string;
  expectedField: ObjectField;
  valueType: TypeId;
  isSpread: boolean;
};

const forEachNominalObjectEntryField = ({
  entry,
  declared,
  ctx,
  state,
  typeName,
  onField,
}: {
  entry: HirObjectLiteralEntry;
  declared: Map<string, ObjectField>;
  ctx: TypingContext;
  state: TypingState;
  typeName: string;
  onField: (field: NominalObjectEntryField) => void;
}): void => {
  if (entry.kind === "field") {
    const expectedField = resolveExpectedNominalField({
      declared,
      name: entry.name,
      typeName,
      span: entry.span,
      ctx,
    });
    const valueSpan = ctx.hir.expressions.get(entry.value)?.span ?? entry.span;
    assertFieldAccess({
      field: expectedField,
      ctx,
      state,
      span: valueSpan,
      context: `constructing ${typeName}`,
      allowOwnerPrivate: true,
    });
    const valueType = typeExpression(entry.value, ctx, state, {
      expectedType: expectedField.type,
    });
    onField({
      fieldSpan: valueSpan,
      name: entry.name,
      expectedField,
      valueType,
      isSpread: false,
    });
    return;
  }

  const spreadFields = resolveAccessibleObjectSpreadFields({
    entry,
    ctx,
    state,
    allowOwnerPrivate: true,
  });
  if (!spreadFields) {
    return;
  }

  spreadFields.forEach((field) => {
    const expectedField = resolveExpectedNominalField({
      declared,
      name: field.name,
      typeName,
      span: entry.span,
      ctx,
    });
    onField({
      fieldSpan: entry.span,
      name: field.name,
      expectedField,
      valueType: field.type,
      isSpread: true,
    });
  });
};

const resolveAccessibleObjectSpreadFields = ({
  entry,
  ctx,
  state,
  allowOwnerPrivate,
}: {
  entry: HirObjectLiteralEntry;
  ctx: TypingContext;
  state: TypingState;
  allowOwnerPrivate?: boolean;
}): readonly ObjectField[] | undefined => {
  const spreadType = typeExpression(entry.value, ctx, state);
  if (spreadType === ctx.primitives.unknown) {
    return undefined;
  }
  const spreadFields = getStructuralFields(spreadType, ctx, state, {
    includeInaccessible: true,
    allowOwnerPrivate,
  });
  if (!spreadFields) {
    return emitDiagnostic({
      ctx,
      code: "TY0027",
      params: {
        kind: "type-mismatch",
        expected: "structural object",
        actual: typeDescriptorToUserString(
          ctx.arena.get(spreadType),
          ctx.arena,
        ),
      },
      span: normalizeSpan(entry.span),
    });
  }
  return filterAccessibleFields(spreadFields, ctx, state, {
    allowOwnerPrivate,
  });
};

const resolveExpectedNominalField = ({
  declared,
  name,
  typeName,
  span,
  ctx,
}: {
  declared: Map<string, ObjectField>;
  name: string;
  typeName: string;
  span: SourceSpan;
  ctx: TypingContext;
}): ObjectField => {
  const expectedField = declared.get(name);
  if (expectedField) {
    return expectedField;
  }
  return emitUnknownObjectFieldDiagnostic({
    field: name,
    receiver: typeName,
    span,
    ctx,
  });
};

const emitUnknownObjectFieldDiagnostic = ({
  field,
  receiver,
  span,
  ctx,
}: {
  field: string;
  receiver: string;
  span: SourceSpan;
  ctx: TypingContext;
}): never =>
  emitDiagnostic({
    ctx,
    code: "TY0033",
    params: { kind: "unknown-field", name: field, receiver },
    span: normalizeSpan(span),
  });

const emitMissingObjectFieldDiagnostic = ({
  field,
  receiver,
  span,
  ctx,
}: {
  field: string;
  receiver: string;
  span: SourceSpan;
  ctx: TypingContext;
}): never =>
  emitDiagnostic({
    ctx,
    code: "TY0037",
    params: { kind: "missing-object-field", field, receiver },
    span: normalizeSpan(span),
  });
