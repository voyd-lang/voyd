import type {
  HirObjectLiteralEntry,
  HirObjectLiteralExpr,
} from "../../hir/index.js";
import type { SourceSpan, TypeId, TypeParamId } from "../../ids.js";
import { typeExpression } from "../expressions.js";
import { composeEffectRows, getExprEffectRow } from "../effects.js";
import {
  bindTypeParamsFromType,
  ensureObjectType,
  ensureTypeMatches,
  getObjectTemplate,
  getStructuralFields,
  getSymbolName,
  resolveTypeExpr,
} from "../type-system.js";
import {
  typeDescriptorToUserString,
  type StructuralField,
} from "../type-arena.js";
import type { TypingContext, TypingState } from "../types.js";
import {
  assertFieldAccess,
  canAccessField,
  filterAccessibleFields,
  reportInaccessibleFieldRequirement,
} from "../visibility.js";
import { emitDiagnostic, normalizeSpan } from "../../../diagnostics/index.js";

export const typeObjectLiteralExpr = (
  expr: HirObjectLiteralExpr,
  ctx: TypingContext,
  state: TypingState
): TypeId => {
  if (expr.literalKind === "nominal") {
    return typeNominalObjectLiteral(expr, ctx, state);
  }

  const fields = new Map<string, TypeId>();
  expr.entries.forEach((entry) =>
    mergeObjectLiteralEntry(entry, fields, ctx, state)
  );

  const orderedFields = Array.from(fields.entries()).map(([name, type]) => ({
    name,
    type,
  }));
  const effectRow = composeEffectRows(
    ctx.effects,
    expr.entries.map((entry) => getExprEffectRow(entry.value, ctx))
  );
  ctx.effects.setExprEffect(expr.id, effectRow);
  return ctx.arena.internStructuralObject({ fields: orderedFields });
};

const mergeObjectLiteralEntry = (
  entry: HirObjectLiteralEntry,
  fields: Map<string, TypeId>,
  ctx: TypingContext,
  state: TypingState
): void => {
  if (entry.kind === "field") {
    const valueType = typeExpression(entry.value, ctx, state);
    fields.set(entry.name, valueType);
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

  spreadFields.forEach((field) =>
    fields.set(field.name, field.type)
  );
};

const typeNominalObjectLiteral = (
  expr: HirObjectLiteralExpr,
  ctx: TypingContext,
  state: TypingState
): TypeId => {
  const namedTarget =
    expr.target?.typeKind === "named" ? expr.target : undefined;
  const targetSymbol =
    expr.targetSymbol ??
    namedTarget?.symbol ??
    (namedTarget ? ctx.objects.resolveName(namedTarget.path[0]!) : undefined);
  if (typeof targetSymbol !== "number") {
    throw new Error("nominal object literal missing target type");
  }

  const template = getObjectTemplate(targetSymbol, ctx, state);
  if (!template) {
    throw new Error("missing object template for nominal literal");
  }

  const typeName = getSymbolName(targetSymbol, ctx);
  const templateFields = new Map<string, StructuralField>(
    template.fields.map((field) => [field.name, field])
  );
  const typeParamBindings = new Map<TypeParamId, TypeId>();
  const seenFields = new Set<string>();

  expr.entries.forEach((entry) =>
    bindNominalObjectEntry({
      entry,
      declared: templateFields,
      bindings: typeParamBindings,
      provided: seenFields,
      ctx,
      state,
      typeName,
    })
  );

  const explicitTypeArgs =
    namedTarget?.typeArguments?.map((arg) =>
      resolveTypeExpr(arg, ctx, state, ctx.primitives.unknown)
    ) ?? [];
  const typeArgs = template.params.map((param, index) => {
    const explicit = explicitTypeArgs[index];
    if (typeof explicit === "number") {
      return explicit;
    }
    const inferred = typeParamBindings.get(param.typeParam);
    return inferred ?? ctx.primitives.unknown;
  });

  const objectInfo = ensureObjectType(targetSymbol, ctx, state, typeArgs);
  if (!objectInfo) {
    throw new Error("missing object type information for nominal literal");
  }

  const declaredFields = new Map<string, StructuralField>(
    objectInfo.fields.map((field) => [field.name, field])
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
    })
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
    expr.entries.map((entry) => getExprEffectRow(entry.value, ctx))
  );
  ctx.effects.setExprEffect(expr.id, effectRow);
  return objectInfo.type;
};

const bindNominalObjectEntry = (
  {
    entry,
    declared,
    bindings,
    provided,
    ctx,
    state,
    typeName,
  }: {
    entry: HirObjectLiteralEntry;
    declared: Map<string, StructuralField>;
    bindings: Map<TypeParamId, TypeId>;
    provided: Set<string>;
    ctx: TypingContext;
    state: TypingState;
    typeName: string;
  }
): void =>
  forEachNominalObjectEntryField({
    entry,
    declared,
    ctx,
    state,
    typeName,
    onField: ({ name, expectedField, valueType }) => {
      bindTypeParamsFromType(expectedField.type, valueType, bindings, ctx, state);
      provided.add(name);
    },
  });

const mergeNominalObjectEntry = (
  {
    entry,
    declared,
    provided,
    ctx,
    state,
    typeName,
  }: {
    entry: HirObjectLiteralEntry;
    declared: Map<string, StructuralField>;
    provided: Set<string>;
    ctx: TypingContext;
    state: TypingState;
    typeName: string;
  }
): void =>
  forEachNominalObjectEntryField({
    entry,
    declared,
    ctx,
    state,
    typeName,
    onField: ({ name, expectedField, valueType, isSpread }) => {
      if (expectedField.type !== ctx.primitives.unknown) {
        ensureTypeMatches(
          valueType,
          expectedField.type,
          ctx,
          state,
          isSpread ? `spread field ${name}` : `field ${name}`
        );
      }
      provided.add(name);
    },
  });

type NominalObjectEntryField = {
  name: string;
  expectedField: StructuralField;
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
  declared: Map<string, StructuralField>;
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
    const valueSpan =
      ctx.hir.expressions.get(entry.value)?.span ?? entry.span;
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
    onField({ name: entry.name, expectedField, valueType, isSpread: false });
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
}): readonly StructuralField[] | undefined => {
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
        actual: typeDescriptorToUserString(ctx.arena.get(spreadType), ctx.arena),
      },
      span: normalizeSpan(entry.span),
    });
  }
  return filterAccessibleFields(spreadFields, ctx, state, { allowOwnerPrivate });
};

const resolveExpectedNominalField = ({
  declared,
  name,
  typeName,
  span,
  ctx,
}: {
  declared: Map<string, StructuralField>;
  name: string;
  typeName: string;
  span: SourceSpan;
  ctx: TypingContext;
}): StructuralField => {
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
