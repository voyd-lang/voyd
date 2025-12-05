import type {
  HirObjectLiteralEntry,
  HirObjectLiteralExpr,
} from "../../hir/index.js";
import type { TypeId, TypeParamId } from "../../ids.js";
import { typeExpression } from "../expressions.js";
import {
  bindTypeParamsFromType,
  ensureObjectType,
  ensureTypeMatches,
  getObjectTemplate,
  getStructuralFields,
  getSymbolName,
  resolveTypeExpr,
} from "../type-system.js";
import type { StructuralField } from "../type-arena.js";
import type { TypingContext, TypingState } from "../types.js";
import {
  assertFieldAccess,
  canAccessField,
  filterAccessibleFields,
  reportInaccessibleFieldRequirement,
} from "../visibility.js";

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

  const spreadType = typeExpression(entry.value, ctx, state);
  if (spreadType === ctx.primitives.unknown) {
    return;
  }

  const spreadFields = getStructuralFields(spreadType, ctx, state, {
    includeInaccessible: true,
    allowOwnerPrivate: true,
  });
  if (!spreadFields) {
    throw new Error("object spread requires a structural object");
  }
  filterAccessibleFields(spreadFields, ctx, state).forEach((field) =>
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
    bindNominalObjectEntry(
      entry,
      templateFields,
      typeParamBindings,
      seenFields,
      ctx,
      state,
      typeName
    )
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
    mergeNominalObjectEntry(entry, declaredFields, provided, ctx, state, typeName)
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
      throw new Error(`missing initializer for field ${name}`);
    }
  });

  return objectInfo.type;
};

const bindNominalObjectEntry = (
  entry: HirObjectLiteralEntry,
  declared: Map<string, StructuralField>,
  bindings: Map<TypeParamId, TypeId>,
  provided: Set<string>,
  ctx: TypingContext,
  state: TypingState,
  typeName: string
): void => {
  if (entry.kind === "field") {
    const expectedField = declared.get(entry.name);
    if (!expectedField) {
      throw new Error(`nominal object does not declare field ${entry.name}`);
    }
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
    const valueType = typeExpression(entry.value, ctx, state, expectedField.type);
    bindTypeParamsFromType(expectedField.type, valueType, bindings, ctx, state);
    provided.add(entry.name);
    return;
  }

  const spreadType = typeExpression(entry.value, ctx, state);
  if (spreadType === ctx.primitives.unknown) {
    return;
  }

  const spreadFields = getStructuralFields(spreadType, ctx, state, {
    includeInaccessible: true,
    allowOwnerPrivate: true,
  });
  if (!spreadFields) {
    throw new Error("object spread requires a structural object");
  }

  filterAccessibleFields(spreadFields, ctx, state, { allowOwnerPrivate: true }).forEach((field) => {
    const expectedField = declared.get(field.name);
    if (!expectedField) {
      throw new Error(`nominal object does not declare field ${field.name}`);
    }
    bindTypeParamsFromType(expectedField.type, field.type, bindings, ctx, state);
    provided.add(field.name);
  });
};

const mergeNominalObjectEntry = (
  entry: HirObjectLiteralEntry,
  declared: Map<string, StructuralField>,
  provided: Set<string>,
  ctx: TypingContext,
  state: TypingState,
  typeName: string
): void => {
  if (entry.kind === "field") {
    const expectedField = declared.get(entry.name);
    if (!expectedField) {
      throw new Error(`nominal object does not declare field ${entry.name}`);
    }
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
    const valueType = typeExpression(entry.value, ctx, state, expectedField.type);
    if (expectedField.type !== ctx.primitives.unknown) {
      ensureTypeMatches(
        valueType,
        expectedField.type,
        ctx,
        state,
        `field ${entry.name}`
      );
    }
    provided.add(entry.name);
    return;
  }

  const spreadType = typeExpression(entry.value, ctx, state);
  if (spreadType === ctx.primitives.unknown) {
    return;
  }

  const spreadFields = getStructuralFields(spreadType, ctx, state, {
    includeInaccessible: true,
    allowOwnerPrivate: true,
  });
  if (!spreadFields) {
    throw new Error("object spread requires a structural object");
  }

  filterAccessibleFields(spreadFields, ctx, state, { allowOwnerPrivate: true }).forEach((field) => {
    const expectedField = declared.get(field.name);
    if (!expectedField) {
      throw new Error(`nominal object does not declare field ${field.name}`);
    }
    if (expectedField.type !== ctx.primitives.unknown) {
      ensureTypeMatches(
        field.type,
        expectedField.type,
        ctx,
        state,
        `spread field ${field.name}`
      );
    }
    provided.add(field.name);
  });
};
