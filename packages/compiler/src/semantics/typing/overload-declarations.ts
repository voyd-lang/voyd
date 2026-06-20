import { diagnosticFromCode, emitDiagnostic } from "../../diagnostics/index.js";
import type { SourceSpan, SymbolId } from "../ids.js";
import type {
  FunctionSignature,
  ParamSignature,
  TypingContext,
  TypingState,
} from "./types.js";
import { satisfies as typeSatisfies } from "./type-relations.js";
import { getSymbolName } from "./type-system.js";

type LabeledOverloadShape = {
  symbol: SymbolId;
  signature: FunctionSignature;
  labelStart: number;
  fields: ReadonlyMap<string, ParamSignature>;
};

export const validateSubsumingLabeledOverloads = (
  ctx: TypingContext,
  state: TypingState,
): void => {
  ctx.overloads.forEach((symbols) => {
    const shapes = symbols.flatMap((symbol) => {
      const signature = ctx.functions.getSignature(symbol);
      const fn = ctx.functions.getFunction(symbol);
      if (!signature || !fn) {
        return [];
      }
      const shape = labeledShapeFor({ symbol, signature });
      return shape ? [shape] : [];
    });

    for (let leftIndex = 0; leftIndex < shapes.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < shapes.length;
        rightIndex += 1
      ) {
        reportSubsumingPair({
          left: shapes[leftIndex]!,
          right: shapes[rightIndex]!,
          ctx,
          state,
        });
      }
    }
  });
};

const labeledShapeFor = ({
  symbol,
  signature,
}: {
  symbol: SymbolId;
  signature: FunctionSignature;
}): LabeledOverloadShape | undefined => {
  const parameters = signature.parameters.filter(
    (param) => param.synthetic !== "stable-callsite-id",
  );
  const labelStart = parameters.findIndex((param) => param.label !== undefined);
  if (labelStart < 0) {
    return undefined;
  }
  if (parameters.slice(labelStart).some((param) => param.label === undefined)) {
    return undefined;
  }

  const fields = new Map<string, ParamSignature>();
  parameters.slice(labelStart).forEach((param) => {
    if (param.label) {
      fields.set(param.label, param);
    }
  });
  if (fields.size === 0) {
    return undefined;
  }

  return {
    symbol,
    signature: {
      ...signature,
      parameters,
    },
    labelStart,
    fields,
  };
};

const reportSubsumingPair = ({
  left,
  right,
  ctx,
  state,
}: {
  left: LabeledOverloadShape;
  right: LabeledOverloadShape;
  ctx: TypingContext;
  state: TypingState;
}): void => {
  if (!positionalPrefixesOverlap({ left, right, ctx, state })) {
    return;
  }

  if (shapeSubsumes({ candidate: left, other: right, ctx, state })) {
    reportSubsumingOverload({
      subsuming: left,
      subsumed: right,
      ctx,
    });
    return;
  }

  if (shapeSubsumes({ candidate: right, other: left, ctx, state })) {
    reportSubsumingOverload({
      subsuming: right,
      subsumed: left,
      ctx,
    });
  }
};

const positionalPrefixesOverlap = ({
  left,
  right,
  ctx,
  state,
}: {
  left: LabeledOverloadShape;
  right: LabeledOverloadShape;
  ctx: TypingContext;
  state: TypingState;
}): boolean => {
  if (left.labelStart !== right.labelStart) {
    return false;
  }

  for (let index = 0; index < left.labelStart; index += 1) {
    const leftParam = left.signature.parameters[index]!;
    const rightParam = right.signature.parameters[index]!;
    if (leftParam.label !== rightParam.label) {
      return false;
    }
    if (
      !typesOverlap({
        left: leftParam.type,
        right: rightParam.type,
        ctx,
        state,
      })
    ) {
      return false;
    }
  }

  return true;
};

const shapeSubsumes = ({
  candidate,
  other,
  ctx,
  state,
}: {
  candidate: LabeledOverloadShape;
  other: LabeledOverloadShape;
  ctx: TypingContext;
  state: TypingState;
}): boolean => {
  if (candidate.fields.size <= other.fields.size) {
    return false;
  }

  for (const [label, otherParam] of other.fields) {
    const candidateParam = candidate.fields.get(label);
    if (!candidateParam) {
      return false;
    }
    if (
      !typesOverlap({
        left: candidateParam.type,
        right: otherParam.type,
        ctx,
        state,
      })
    ) {
      return false;
    }
  }

  return true;
};

const typesOverlap = ({
  left,
  right,
  ctx,
  state,
}: {
  left: number;
  right: number;
  ctx: TypingContext;
  state: TypingState;
}): boolean => {
  if (left === right) {
    return true;
  }

  const leftDesc = ctx.arena.get(left);
  if (leftDesc.kind === "union") {
    return leftDesc.members.some((member) =>
      typesOverlap({ left: member, right, ctx, state }),
    );
  }

  const rightDesc = ctx.arena.get(right);
  if (rightDesc.kind === "union") {
    return rightDesc.members.some((member) =>
      typesOverlap({ left, right: member, ctx, state }),
    );
  }

  if (
    containsTypeParamRef({ type: left, ctx }) ||
    containsTypeParamRef({ type: right, ctx })
  ) {
    return false;
  }

  return (
    typeSatisfies(left, right, ctx, state) ||
    typeSatisfies(right, left, ctx, state)
  );
};

const containsTypeParamRef = ({
  type,
  ctx,
  seen = new Set<number>(),
}: {
  type: number;
  ctx: TypingContext;
  seen?: Set<number>;
}): boolean => {
  if (seen.has(type)) {
    return false;
  }
  seen.add(type);

  const desc = ctx.arena.get(type);
  switch (desc.kind) {
    case "type-param-ref":
      return true;
    case "recursive":
      return containsTypeParamRef({ type: desc.body, ctx, seen });
    case "trait":
    case "nominal-object":
    case "value-object":
      return desc.typeArgs.some((arg) =>
        containsTypeParamRef({ type: arg, ctx, seen }),
      );
    case "structural-object":
      return desc.fields.some((field) =>
        containsTypeParamRef({ type: field.type, ctx, seen }),
      );
    case "function":
      return (
        desc.parameters.some((param) =>
          containsTypeParamRef({ type: param.type, ctx, seen }),
        ) || containsTypeParamRef({ type: desc.returnType, ctx, seen })
      );
    case "union":
      return desc.members.some((member) =>
        containsTypeParamRef({ type: member, ctx, seen }),
      );
    case "intersection":
      return [
        desc.nominal,
        desc.structural,
        ...(desc.traits ?? []),
      ].some(
        (component): component is number =>
          typeof component === "number" &&
          containsTypeParamRef({ type: component, ctx, seen }),
      );
    case "fixed-array":
      return containsTypeParamRef({ type: desc.element, ctx, seen });
    case "primitive":
      return false;
  }
};

const reportSubsumingOverload = ({
  subsuming,
  subsumed,
  ctx,
}: {
  subsuming: LabeledOverloadShape;
  subsumed: LabeledOverloadShape;
  ctx: TypingContext;
}): void => {
  const functionName = getSymbolName(subsuming.symbol, ctx);
  emitDiagnostic({
    ctx,
    code: "TY0047",
    params: {
      kind: "subsuming-labeled-overload",
      functionName,
      subsumingSignature: formatSignature(subsuming, ctx),
      subsumedSignature: formatSignature(subsumed, ctx),
    },
    span: spanFor(subsuming, ctx),
    related: [
      diagnosticFromCode({
        code: "TY0047",
        params: { kind: "subsumed-labeled-overload" },
        span: spanFor(subsumed, ctx),
        severity: "note",
      }),
    ],
  });
};

const formatSignature = (
  shape: LabeledOverloadShape,
  ctx: TypingContext,
): string => {
  const name = getSymbolName(shape.symbol, ctx);
  const params = shape.signature.parameters
    .map((param) => param.label ?? param.name ?? "_")
    .join(", ");
  return `${name}(${params})`;
};

const spanFor = (
  shape: LabeledOverloadShape,
  ctx: TypingContext,
): SourceSpan => {
  const fn = ctx.functions.getFunction(shape.symbol);
  return fn?.span ?? ctx.hir.module.span;
};
