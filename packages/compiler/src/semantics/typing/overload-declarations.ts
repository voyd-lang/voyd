import { diagnosticFromCode, emitDiagnostic } from "../../diagnostics/index.js";
import type { SourceSpan, SymbolId, TypeId, TypeParamId } from "../ids.js";
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

type OverlapContext = {
  bindings: Map<TypeParamId, TypeId>;
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
  const prefixOverlap = positionalPrefixesOverlap({ left, right, ctx, state });
  if (!prefixOverlap) {
    return;
  }

  if (
    shapeSubsumes({
      candidate: left,
      other: right,
      ctx,
      state,
      overlap: cloneOverlap(prefixOverlap),
    })
  ) {
    reportSubsumingOverload({
      subsuming: left,
      subsumed: right,
      ctx,
    });
    return;
  }

  if (
    shapeSubsumes({
      candidate: right,
      other: left,
      ctx,
      state,
      overlap: cloneOverlap(prefixOverlap),
    })
  ) {
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
}): OverlapContext | undefined => {
  if (left.labelStart !== right.labelStart) {
    return undefined;
  }

  const overlap = createOverlapContext();
  for (let index = 0; index < left.labelStart; index += 1) {
    const leftParam = left.signature.parameters[index]!;
    const rightParam = right.signature.parameters[index]!;
    if (leftParam.label !== rightParam.label) {
      return undefined;
    }
    if (
      !typesOverlap({
        left: leftParam.type,
        right: rightParam.type,
        ctx,
        state,
        overlap,
      })
    ) {
      return undefined;
    }
  }

  return overlap;
};

const shapeSubsumes = ({
  candidate,
  other,
  ctx,
  state,
  overlap,
}: {
  candidate: LabeledOverloadShape;
  other: LabeledOverloadShape;
  ctx: TypingContext;
  state: TypingState;
  overlap: OverlapContext;
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
        overlap,
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
  overlap,
}: {
  left: TypeId;
  right: TypeId;
  ctx: TypingContext;
  state: TypingState;
  overlap: OverlapContext;
}): boolean => {
  left = resolveBoundType({ type: left, overlap, ctx });
  right = resolveBoundType({ type: right, overlap, ctx });
  if (left === right) {
    return true;
  }

  const leftDesc = ctx.arena.get(left);
  if (leftDesc.kind === "type-param-ref") {
    return bindTypeParameter({
      param: leftDesc.param,
      type: right,
      ctx,
      state,
      overlap,
    });
  }

  if (leftDesc.kind === "union") {
    return leftDesc.members.some((member) =>
      withForkedOverlap(overlap, (candidate) =>
        typesOverlap({ left: member, right, ctx, state, overlap: candidate }),
      ),
    );
  }

  const rightDesc = ctx.arena.get(right);
  if (rightDesc.kind === "type-param-ref") {
    return bindTypeParameter({
      param: rightDesc.param,
      type: left,
      ctx,
      state,
      overlap,
    });
  }

  if (rightDesc.kind === "union") {
    return rightDesc.members.some((member) =>
      withForkedOverlap(overlap, (candidate) =>
        typesOverlap({ left, right: member, ctx, state, overlap: candidate }),
      ),
    );
  }

  const leftFields = structuralFieldsFor({ type: left, ctx });
  const rightFields = structuralFieldsFor({ type: right, ctx });
  if (leftFields && rightFields) {
    return structuralShapesOverlap({
      left: leftFields,
      right: rightFields,
      ctx,
      state,
      overlap,
    });
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

const createOverlapContext = (): OverlapContext => ({
  bindings: new Map(),
});

const cloneOverlap = (overlap: OverlapContext): OverlapContext => ({
  bindings: new Map(overlap.bindings),
});

const withForkedOverlap = (
  overlap: OverlapContext,
  run: (candidate: OverlapContext) => boolean,
): boolean => {
  const candidate = cloneOverlap(overlap);
  if (!run(candidate)) {
    return false;
  }
  overlap.bindings.clear();
  candidate.bindings.forEach((value, key) => overlap.bindings.set(key, value));
  return true;
};

const resolveBoundType = ({
  type,
  overlap,
  ctx,
}: {
  type: TypeId;
  overlap: OverlapContext;
  ctx: TypingContext;
}): TypeId => {
  const seen = new Set<TypeParamId>();
  let current = type;
  while (true) {
    const desc = ctx.arena.get(current);
    if (desc.kind !== "type-param-ref") {
      return current;
    }
    if (seen.has(desc.param)) {
      return current;
    }
    seen.add(desc.param);
    const binding = overlap.bindings.get(desc.param);
    if (typeof binding !== "number") {
      return current;
    }
    current = binding;
  }
};

const bindTypeParameter = ({
  param,
  type,
  ctx,
  state,
  overlap,
}: {
  param: TypeParamId;
  type: TypeId;
  ctx: TypingContext;
  state: TypingState;
  overlap: OverlapContext;
}): boolean => {
  const typeDesc = ctx.arena.get(type);
  if (typeDesc.kind === "type-param-ref" && typeDesc.param === param) {
    return true;
  }
  const existing = overlap.bindings.get(param);
  if (typeof existing === "number") {
    return typesOverlap({ left: existing, right: type, ctx, state, overlap });
  }
  overlap.bindings.set(param, type);
  return true;
};

const structuralFieldsFor = ({
  type,
  ctx,
}: {
  type: TypeId;
  ctx: TypingContext;
}): readonly ParamSignature[] | undefined => {
  const desc = ctx.arena.get(type);
  if (desc.kind === "structural-object") {
    return desc.fields.map((field) => ({
      type: field.type,
      label: field.name,
      name: field.name,
      optional: field.optional,
    }));
  }
  return undefined;
};

const structuralShapesOverlap = ({
  left,
  right,
  ctx,
  state,
  overlap,
}: {
  left: readonly ParamSignature[];
  right: readonly ParamSignature[];
  ctx: TypingContext;
  state: TypingState;
  overlap: OverlapContext;
}): boolean => {
  const rightByName = new Map(
    right
      .map((field) => [field.label ?? field.name, field] as const)
      .filter((entry): entry is [string, ParamSignature] => Boolean(entry[0])),
  );

  for (const leftField of left) {
    const name = leftField.label ?? leftField.name;
    if (!name) {
      continue;
    }
    const rightField = rightByName.get(name);
    if (!rightField) {
      continue;
    }
    if (
      !typesOverlap({
        left: leftField.type,
        right: rightField.type,
        ctx,
        state,
        overlap,
      })
    ) {
      return false;
    }
  }

  return true;
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
