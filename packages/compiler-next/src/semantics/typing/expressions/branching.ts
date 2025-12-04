import type { TypeId } from "../../ids.js";
import type { TypingContext, TypingState } from "../types.js";
import { typeSatisfies } from "../type-system.js";

export const mergeBranchType = ({
  acc,
  next,
  ctx,
  state,
}: {
  acc: TypeId | undefined;
  next: TypeId;
  ctx: TypingContext;
  state: TypingState;
}): TypeId => {
  if (typeof acc !== "number") {
    return next;
  }
  if (acc === next) {
    return acc;
  }
  if (typeSatisfies(next, acc, ctx, state)) {
    return acc;
  }
  if (typeSatisfies(acc, next, ctx, state)) {
    return next;
  }
  const accRepr = branchWasmRepresentation(acc, ctx);
  const nextRepr = branchWasmRepresentation(next, ctx);
  if (accRepr === "unknown" || nextRepr === "unknown") {
    return ctx.arena.internUnion([acc, next]);
  }
  if (accRepr === "mixed" || nextRepr === "mixed" || accRepr !== nextRepr) {
    throw new Error("branch type mismatch");
  }
  return ctx.arena.internUnion([acc, next]);
};

type BranchWasmRepresentation =
  | "i32"
  | "i64"
  | "f32"
  | "f64"
  | "void"
  | "ref"
  | "unknown"
  | "mixed";

export const branchWasmRepresentation = (
  type: TypeId,
  ctx: TypingContext,
  seen: Set<TypeId> = new Set()
): BranchWasmRepresentation => {
  if (seen.has(type)) {
    return "ref";
  }
  seen.add(type);

  const desc = ctx.arena.get(type);
  switch (desc.kind) {
    case "primitive":
      switch (desc.name) {
        case "i32":
        case "bool":
        case "boolean":
        case "unknown":
          return "i32";
        case "i64":
          return "i64";
        case "f32":
          return "f32";
        case "f64":
          return "f64";
        case "voyd":
        case "void":
        case "Voyd":
          return "void";
        default:
          return "ref";
      }
    case "trait":
    case "nominal-object":
    case "structural-object":
    case "function":
    case "fixed-array":
      return "ref";
    case "union": {
      const memberReprs = new Set(
        desc.members.map((member) =>
          branchWasmRepresentation(member, ctx, seen)
        )
      );
      return memberReprs.size === 1
        ? memberReprs.values().next().value ?? "mixed"
        : "mixed";
    }
    case "intersection": {
      const reps = new Set<BranchWasmRepresentation>();
      if (typeof desc.nominal === "number") {
        reps.add(branchWasmRepresentation(desc.nominal, ctx, seen));
      }
      if (typeof desc.structural === "number") {
        reps.add(branchWasmRepresentation(desc.structural, ctx, seen));
      }
      return reps.size === 1 ? reps.values().next().value ?? "mixed" : "mixed";
    }
    case "type-param-ref":
      return "unknown";
    default:
      return "mixed";
  }
};
