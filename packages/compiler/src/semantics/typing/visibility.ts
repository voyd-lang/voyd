import { emitDiagnostic, normalizeSpan } from "../../diagnostics/index.js";
import type { SourceSpan } from "../ids.js";
import type { StructuralField } from "./type-arena.js";
import type {
  MemberMetadata,
  TypingContext,
  TypingState,
} from "./types.js";

const visibilityLabel = (
  visibility: StructuralField["visibility"] | MemberMetadata["visibility"]
): string => {
  if (!visibility) {
    return "unknown";
  }
  const base = visibility.level === "object" ? "pri" : visibility.level;
  return visibility.api ? `${base} (api)` : base;
};

const sharesPackage = (
  packageId: string | undefined,
  ctx: TypingContext
): boolean => (packageId ?? ctx.packageId) === ctx.packageId;

export const canAccessField = (
  field: StructuralField,
  ctx: TypingContext,
  state: TypingState,
  options: { allowOwnerPrivate?: boolean } = {}
): boolean => {
  const visibility = field.visibility;
  if (!visibility) {
    return true;
  }
  if (visibility.level === "object") {
    const sameOwner =
      field.owner !== undefined &&
      state.currentFunction?.memberOf === field.owner;
    if (sameOwner) {
      return true;
    }
    const samePackage = sharesPackage(field.packageId, ctx);
    if (options.allowOwnerPrivate && samePackage && field.owner !== undefined) {
      return true;
    }
    return false;
  }
  const samePackage = sharesPackage(field.packageId, ctx);
  if (samePackage) {
    return true;
  }
  return visibility.api === true;
};

export const filterAccessibleFields = (
  fields: readonly StructuralField[],
  ctx: TypingContext,
  state: TypingState,
  options: { allowOwnerPrivate?: boolean } = {}
): StructuralField[] =>
  fields.filter((field) => canAccessField(field, ctx, state, options));

const canAccessMember = (
  metadata: MemberMetadata | undefined,
  ctx: TypingContext,
  state: TypingState
): boolean => {
  if (!metadata?.visibility) {
    return true;
  }
  if (metadata.visibility.level === "object") {
    return (
      typeof metadata.owner === "number" &&
      state.currentFunction?.memberOf === metadata.owner
    );
  }
  const samePackage = sharesPackage(metadata.packageId, ctx);
  if (samePackage) {
    return true;
  }
  return metadata.visibility.api === true;
};

export const assertFieldAccess = ({
  field,
  ctx,
  state,
  span,
  context,
  allowOwnerPrivate,
}: {
  field: StructuralField;
  ctx: TypingContext;
  state: TypingState;
  span?: SourceSpan;
  context?: string;
  allowOwnerPrivate?: boolean;
}): void => {
  if (canAccessField(field, ctx, state, { allowOwnerPrivate })) {
    return;
  }
  emitDiagnostic({
    ctx,
    code: "TY0009",
    params: {
      kind: "member-access",
      memberKind: "field",
      name: field.name,
      visibility: visibilityLabel(field.visibility),
      context,
    },
    span: normalizeSpan(span),
  });
};

export const assertMemberAccess = ({
  symbol,
  ctx,
  state,
  span,
  context,
}: {
  symbol: number;
  ctx: TypingContext;
  state: TypingState;
  span?: SourceSpan;
  context?: string;
}): void => {
  const metadata = ctx.memberMetadata.get(symbol);
  if (!metadata || canAccessMember(metadata, ctx, state)) {
    return;
  }
  const name = ctx.symbolTable.getSymbol(symbol).name;
  emitDiagnostic({
    ctx,
    code: "TY0009",
    params: {
      kind: "member-access",
      memberKind: "method",
      name,
      visibility: visibilityLabel(metadata.visibility),
      context,
    },
    span: normalizeSpan(span),
  });
};

export const reportInaccessibleFieldRequirement = ({
  field,
  typeName,
  ctx,
  state,
  span,
  allowOwnerPrivate,
}: {
  field: StructuralField;
  typeName: string;
  ctx: TypingContext;
  state: TypingState;
  span?: SourceSpan;
  allowOwnerPrivate?: boolean;
}): void => {
  if (canAccessField(field, ctx, state, { allowOwnerPrivate })) {
    return;
  }
  emitDiagnostic({
    ctx,
    code: "TY0010",
    params: {
      kind: "inaccessible-construction",
      typeName,
      member: field.name,
      visibility: visibilityLabel(field.visibility),
    },
    span: normalizeSpan(span),
  });
};
