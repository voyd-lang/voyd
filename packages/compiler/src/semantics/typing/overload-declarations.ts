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
  // V-405 targets overloads where the entire parameter surface is a structural
  // labeled shape. Mixed positional/labeled builder APIs have separate call
  // compatibility rules and are intentionally left to call resolution.
  if (labelStart !== 0) {
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
      !typesCompatible({
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

const typesCompatible = ({
  left,
  right,
  ctx,
  state,
}: {
  left: number;
  right: number;
  ctx: TypingContext;
  state: TypingState;
}): boolean =>
  left === right ||
  typeSatisfies(left, right, ctx, state) ||
  typeSatisfies(right, left, ctx, state);

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
