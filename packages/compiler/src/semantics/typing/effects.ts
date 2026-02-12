import type {
  EffectRowId,
  SymbolId,
  NodeId,
  SourceSpan,
  HirExprId,
} from "../ids.js";
import type { TypingContext, TypingState } from "./types.js";
import type { EffectTable } from "../effects/effect-table.js";
import { emitDiagnostic } from "../../diagnostics/index.js";
import type {
  HirTypeExpr,
  HirNamedTypeExpr,
} from "../hir/index.js";
import type { Expr } from "../../parser/index.js";
import { formatTypeAnnotation } from "../utils.js";

const pureEffectRow = (effects: EffectTable): EffectRowId => effects.emptyRow;

const effectOperationKeyFromDecl = ({
  effectName,
  opName,
  params,
}: {
  effectName: string;
  opName: string;
  params: readonly { typeExpr?: Expr }[];
}): string => {
  if (params.length === 0) {
    return `${effectName}.${opName}`;
  }
  return `${effectName}.${opName}(${params
    .map((p) => formatTypeAnnotation(p.typeExpr))
    .join(",")})`;
};

export const freshOpenEffectRow = (
  effects: EffectTable,
  options?: { rigid?: boolean }
): EffectRowId =>
  effects.internRow({
    operations: [],
    tailVar: effects.freshTailVar({ rigid: options?.rigid }),
  });

export const composeEffectRows = (
  effects: EffectTable,
  rows: readonly EffectRowId[]
): EffectRowId =>
  rows.reduce((acc, row) => effects.compose(acc, row), pureEffectRow(effects));

export const getExprEffectRow = (
  expr: HirExprId,
  ctx: TypingContext
): EffectRowId => ctx.effects.getExprEffect(expr) ?? pureEffectRow(ctx.effects);

export const effectOpName = (
  symbol: SymbolId,
  ctx: TypingContext
): string => {
  const record = ctx.symbolTable.getSymbol(symbol);
  const ownerEffect = (record.metadata as { ownerEffect?: SymbolId } | undefined)
    ?.ownerEffect;
  if (typeof ownerEffect !== "number") {
    return record.name;
  }
  const decl = ctx.decls.getEffectOperation(symbol);
  const effectName = ctx.symbolTable.getSymbol(ownerEffect).name;
  if (!decl) {
    return `${effectName}.${record.name}`;
  }
  return effectOperationKeyFromDecl({
    effectName,
    opName: decl.operation.name,
    params: decl.operation.parameters,
  });
};

const resolveNamedEffectRow = (
  expr: HirNamedTypeExpr,
  ctx: TypingContext
): EffectRowId => {
  const symbol =
    typeof expr.symbol === "number"
      ? expr.symbol
      : ctx.symbolTable.resolve(expr.path[0] ?? "", ctx.symbolTable.rootScope);
  if (typeof symbol !== "number") {
    return pureEffectRow(ctx.effects);
  }

  const record = ctx.symbolTable.getSymbol(symbol);
  if (record.kind === "effect") {
    const decl = ctx.decls.getEffect(symbol);
    const effectName = record.name;
    const ops =
      decl?.operations.map((op) => ({
        name: effectOperationKeyFromDecl({
          effectName,
          opName: op.name,
          params: op.parameters,
        }),
      })) ?? [];
    return ctx.effects.internRow({ operations: ops });
  }

  if (record.kind === "effect-op") {
    return ctx.effects.internRow({
      operations: [{ name: effectOpName(symbol, ctx) }],
    });
  }

  return freshOpenEffectRow(ctx.effects);
};

const resolveEffectRowFromExpr = (
  effectType: HirTypeExpr,
  ctx: TypingContext,
  state: TypingState
): EffectRowId => {
  const compose = (types: readonly HirTypeExpr[]): EffectRowId =>
    composeEffectRows(
      ctx.effects,
      types.map((type) => resolveEffectRowFromExpr(type, ctx, state))
    );

  switch (effectType.typeKind) {
    case "named":
      return resolveNamedEffectRow(effectType, ctx);
    case "tuple":
      return compose(effectType.elements);
    case "union":
      return compose(effectType.members);
    case "intersection":
      return compose(effectType.members);
    case "function":
      return typeof effectType.effectType !== "undefined"
        ? resolveEffectRowFromExpr(effectType.effectType, ctx, state)
        : freshOpenEffectRow(ctx.effects);
    default:
      return freshOpenEffectRow(ctx.effects);
  }
};

export const resolveEffectAnnotation = (
  effectType: HirTypeExpr | undefined,
  ctx: TypingContext,
  state: TypingState
): EffectRowId | undefined =>
  effectType ? resolveEffectRowFromExpr(effectType, ctx, state) : undefined;

export const applyEffectRowSubstitution = ({
  row,
  substitution,
  effects,
}: {
  row: EffectRowId;
  substitution: ReadonlyMap<number, EffectRowId>;
  effects: EffectTable;
}): EffectRowId => {
  if (substitution.size === 0) {
    return row;
  }

  const visit = (current: EffectRowId, seen: Set<EffectRowId>): EffectRowId => {
    if (seen.has(current)) {
      return current;
    }
    seen.add(current);

    const desc = effects.getRow(current);
    const tail = desc.tailVar;
    if (!tail) {
      seen.delete(current);
      return current;
    }

    const replacement = substitution.get(tail.id);
    if (typeof replacement !== "number") {
      seen.delete(current);
      return current;
    }

    const appliedReplacement = visit(replacement, seen);
    const replacementDesc = effects.getRow(appliedReplacement);
    const next = effects.internRow({
      operations: [...desc.operations, ...replacementDesc.operations],
      tailVar: replacementDesc.tailVar,
    });
    seen.delete(current);
    return next;
  };

  return visit(row, new Set());
};

export const ensureEffectCompatibility = ({
  inferred,
  annotated,
  ctx,
  span,
  location,
  reason,
  mode = "upper-bound",
}: {
  inferred: EffectRowId;
  annotated: EffectRowId;
  ctx: TypingContext;
  span: SourceSpan;
  location: NodeId;
  reason: string;
  mode?: "upper-bound" | "exact";
}): boolean => {
  const forward = ctx.effects.constrain(inferred, annotated, {
    location,
    reason,
  });
  if (!forward.ok) {
    emitDiagnostic({
      ctx,
      code: "TY0014",
      params: {
        kind: "effect-annotation-mismatch",
        message: forward.conflict.message,
      },
      span,
    });
    return false;
  }

  if (mode === "upper-bound") {
    return true;
  }

  const backward = ctx.effects.constrain(annotated, inferred, { location, reason });
  if (backward.ok) {
    return true;
  }

  emitDiagnostic({
    ctx,
    code: "TY0014",
    params: {
      kind: "effect-annotation-mismatch",
      message: backward.conflict.message,
    },
    span,
  });
  return false;
};
