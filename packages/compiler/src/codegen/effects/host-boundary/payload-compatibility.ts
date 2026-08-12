import type { SourceSpan } from "../../../diagnostics/types.js";
import type { TypeId } from "../../../semantics/ids.js";
import type { CodegenContext } from "../../context.js";
import type { EffectOpSignature } from "./types.js";

type HostBoundaryPrimitive = "bool" | "i32" | "i64" | "f32" | "f64" | "void";

type HostBoundaryPayloadPosition =
  | { kind: "argument"; index: number }
  | { kind: "return" };

type UnsupportedPayloadReason = { kind: "unsupported-type" };

export type HostBoundaryPayloadSupport =
  | { supported: true; strategy: "primitive"; primitive: HostBoundaryPrimitive }
  | { supported: true; strategy: "dto" }
  | {
      supported: false;
      typeLabel: string;
      reason: UnsupportedPayloadReason;
    };

export type HostBoundaryPayloadViolation = {
  signature: EffectOpSignature;
  position: HostBoundaryPayloadPosition;
  reason: UnsupportedPayloadReason;
  typeLabel: string;
  span: SourceSpan;
};

export const HOST_BOUNDARY_DTO_COMPATIBILITY_SUMMARY =
  "an automatic DTO type or a type with a CustomDto representation";

const primitiveForType = (
  typeId: TypeId,
  ctx: CodegenContext,
): HostBoundaryPrimitive | undefined => {
  if (typeId === ctx.program.primitives.bool) return "bool";
  if (typeId === ctx.program.primitives.i32) return "i32";
  if (typeId === ctx.program.primitives.i64) return "i64";
  if (typeId === ctx.program.primitives.f32) return "f32";
  if (typeId === ctx.program.primitives.f64) return "f64";
  if (typeId === ctx.program.primitives.void) return "void";
  return undefined;
};

const formatTypeForHostBoundary = ({
  typeId,
  ctx,
  active,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
  active: Set<TypeId>;
}): string => {
  if (active.has(typeId)) {
    return "<recursive>";
  }

  const primitive = primitiveForType(typeId, ctx);
  if (primitive) {
    return primitive;
  }

  const desc = ctx.program.types.getTypeDesc(typeId);
  active.add(typeId);
  try {
    switch (desc.kind) {
      case "primitive":
        return desc.name;
      case "recursive":
        return `recursive<${formatTypeForHostBoundary({
          typeId: desc.body,
          ctx,
          active,
        })}>`;
      case "type-param-ref":
        return `typeparam#${desc.param}`;
      case "nominal-object":
      case "value-object":
      case "trait": {
        const baseName =
          desc.name ??
          ctx.program.symbols.getName(desc.owner) ??
          `symbol#${desc.owner}`;
        if (desc.typeArgs.length === 0) {
          return baseName;
        }
        const args = desc.typeArgs.map((arg) =>
          formatTypeForHostBoundary({ typeId: arg, ctx, active }),
        );
        return `${baseName}<${args.join(", ")}>`;
      }
      case "structural-object":
        return `{ ${desc.fields
          .map(
            (field) =>
              `${field.name}${field.optional ? "?" : ""}: ${formatTypeForHostBoundary(
                {
                  typeId: field.type,
                  ctx,
                  active,
                },
              )}`,
          )
          .join(", ")} }`;
      case "function":
        return `fn(${desc.parameters
          .map((param) =>
            formatTypeForHostBoundary({ typeId: param.type, ctx, active }),
          )
          .join(", ")}) -> ${formatTypeForHostBoundary({
          typeId: desc.returnType,
          ctx,
          active,
        })}`;
      case "union":
        return desc.members
          .map((member) =>
            formatTypeForHostBoundary({ typeId: member, ctx, active }),
          )
          .join(" | ");
      case "intersection": {
        const parts: string[] = [];
        if (typeof desc.nominal === "number") {
          parts.push(
            formatTypeForHostBoundary({
              typeId: desc.nominal,
              ctx,
              active,
            }),
          );
        }
        if (typeof desc.structural === "number") {
          parts.push(
            formatTypeForHostBoundary({
              typeId: desc.structural,
              ctx,
              active,
            }),
          );
        }
        if (desc.traits) {
          parts.push(
            ...desc.traits.map((trait) =>
              formatTypeForHostBoundary({ typeId: trait, ctx, active }),
            ),
          );
        }
        return parts.length > 0 ? parts.join(" & ") : "intersection";
      }
      case "fixed-array":
        return `FixedArray<${formatTypeForHostBoundary({
          typeId: desc.element,
          ctx,
          active,
        })}>`;
      default:
        return `type#${typeId}`;
    }
  } finally {
    active.delete(typeId);
  }
};

export const hostBoundaryPayloadSupportForType = ({
  typeId,
  ctx,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
}): HostBoundaryPayloadSupport => {
  if (ctx.program.dtoPlans.isEligible({ typeId, moduleId: ctx.moduleId })) {
    return { supported: true, strategy: "dto" };
  }

  return {
    supported: false,
    reason: { kind: "unsupported-type" },
    typeLabel: formatTypeForHostBoundary({
      typeId,
      ctx,
      active: new Set<TypeId>(),
    }),
  };
};

const collectViolation = ({
  signature,
  position,
  typeId,
  ctx,
  out,
}: {
  signature: EffectOpSignature;
  position: HostBoundaryPayloadPosition;
  typeId: TypeId;
  ctx: CodegenContext;
  out: HostBoundaryPayloadViolation[];
}): void => {
  const support = hostBoundaryPayloadSupportForType({
    typeId,
    ctx,
  });
  if (support.supported) {
    return;
  }
  out.push({
    signature,
    position,
    reason: support.reason,
    typeLabel: support.typeLabel,
    span: signature.span,
  });
};

export const collectHostBoundaryPayloadViolations = ({
  signatures,
  ctx,
}: {
  signatures: readonly EffectOpSignature[];
  ctx: CodegenContext;
}): HostBoundaryPayloadViolation[] => {
  const violations: HostBoundaryPayloadViolation[] = [];
  signatures.forEach((signature) => {
    if (signature.externalBoundary) return;
    signature.paramTypeIds.forEach((typeId, index) => {
      collectViolation({
        signature,
        position: { kind: "argument", index: index + 1 },
        typeId,
        ctx,
        out: violations,
      });
    });
    collectViolation({
      signature,
      position: { kind: "return" },
      typeId: signature.returnTypeId,
      ctx,
      out: violations,
    });
  });
  return violations;
};

export const formatHostBoundaryPayloadViolation = (
  violation: HostBoundaryPayloadViolation,
): string => {
  const where =
    violation.position.kind === "argument"
      ? `arg${violation.position.index}`
      : "return value";
  const reason = "the type is not host-boundary DTO compatible";
  return `host boundary payload for ${violation.signature.label} ${where} uses unsupported type ${violation.typeLabel}; ${reason}. Supported payload categories: ${HOST_BOUNDARY_DTO_COMPATIBILITY_SUMMARY}.`;
};
