import type { CodegenContext, TypeId } from "../context.js";
import {
  AutoDtoPlanError,
  canonicalDtoPlanBytes,
  dtoPlanFingerprint,
  formatAutoDtoType,
  type AutoDtoFieldPlan,
  type AutoDtoPlan,
  type AutoDtoPrimitivePlan,
} from "../../semantics/codegen-view/auto-dto-plan.js";

export type BoundaryPrimitiveSchema = AutoDtoPrimitivePlan;
export type BoundarySchema = AutoDtoPlan;
export type BoundaryFieldSchema = AutoDtoFieldPlan;
export type BoundaryArraySchema = Extract<AutoDtoPlan, { kind: "array" }>;
export type BoundaryRecordSchema = Extract<AutoDtoPlan, { kind: "record" }>;
export type BoundaryUnionSchema = Extract<AutoDtoPlan, { kind: "union" }>;
export type BoundaryRefSchema = Extract<AutoDtoPlan, { kind: "ref" }>;
export type BoundaryVariantSchema = BoundaryUnionSchema["variants"][number];

export { AutoDtoPlanError as BoundarySchemaError };

/** Retained temporarily while callers migrate to the canonical plan API. */
export type BoundarySchemaOptions = {
  tagStandaloneVariants?: boolean;
  includeDocumentation?: boolean;
  portableNames?: boolean;
};

export const deriveBoundarySchema = ({
  typeId,
  ctx,
  label = "value",
}: {
  typeId: TypeId;
  ctx: CodegenContext;
  label?: string;
  options?: BoundarySchemaOptions;
}): BoundarySchema =>
  ctx.program.dtoPlans.get({ typeId, moduleId: ctx.moduleId, label });

export const isBoundaryCompatibleType = ({
  typeId,
  ctx,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
}): boolean =>
  ctx.program.dtoPlans.isEligible({ typeId, moduleId: ctx.moduleId });

export const withDtoFingerprint = (schema: BoundarySchema): BoundarySchema =>
  schema.fingerprint
    ? schema
    : { ...schema, fingerprint: dtoPlanFingerprint(schema) };

export const dtoSchemaFingerprint = dtoPlanFingerprint;
export const canonicalDtoSchemaBytes = canonicalDtoPlanBytes;

export const formatBoundaryType = ({
  typeId,
  ctx,
  active,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
  active?: Set<TypeId>;
}): string => formatAutoDtoType(typeId, ctx.program, active);
