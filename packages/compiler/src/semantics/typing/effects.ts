import type {
  EffectRowId,
  SymbolId,
  NodeId,
  SourceSpan,
  HirExprId,
} from "../ids.js";
import type { TypingContext, TypingState } from "./types.js";
import {
  effectOpRowKey,
  type EffectOp,
  type EffectTable,
} from "../effects/effect-table.js";
import { formatEffectOp } from "../effects/format.js";
import { emitDiagnostic } from "../../diagnostics/index.js";
import type { HirTypeExpr, HirNamedTypeExpr } from "../hir/index.js";
import type { Expr } from "../../parser/index.js";
import { formatTypeAnnotation } from "../../parser/surface/utils.js";
import type {
  UnificationContext,
  UnificationResult,
} from "../effects/effect-table.js";

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

const importedTargetFor = ({
  symbol,
  ctx,
}: {
  symbol: SymbolId;
  ctx: Pick<TypingContext, "importsByLocal" | "dependencies">;
}): { moduleId: string; symbol: SymbolId } | undefined =>
  ctx.importsByLocal.get(symbol);

const importedEffectOperationDeclFor = ({
  symbol,
  ctx,
}: {
  symbol: SymbolId;
  ctx: Pick<TypingContext, "importsByLocal" | "dependencies">;
}):
  | {
      decl: NonNullable<
        ReturnType<TypingContext["decls"]["getEffectOperation"]>
      >;
      moduleId: string;
    }
  | undefined => {
  const imported = importedTargetFor({ symbol, ctx });
  if (!imported) {
    return undefined;
  }
  const dependency = ctx.dependencies.get(imported.moduleId);
  if (!dependency) {
    return undefined;
  }
  const decl = dependency.decls.getEffectOperation(imported.symbol);
  if (!decl) {
    return undefined;
  }
  return { decl, moduleId: imported.moduleId };
};

const resolvedEffectOperationDeclFor = ({
  symbol,
  ctx,
}: {
  symbol: SymbolId;
  ctx: TypingContext;
}):
  | {
      decl: NonNullable<
        ReturnType<TypingContext["decls"]["getEffectOperation"]>
      >;
      moduleId: string;
    }
  | undefined => {
  const local = ctx.decls.getEffectOperation(symbol);
  return local
    ? { decl: local, moduleId: ctx.moduleId }
    : importedEffectOperationDeclFor({ symbol, ctx });
};

const effectOpFromDecl = ({
  decl,
  moduleId,
}: {
  decl: NonNullable<ReturnType<TypingContext["decls"]["getEffectOperation"]>>;
  moduleId: string;
}): EffectOp => ({
  identity: {
    moduleId,
    effect: decl.effect.symbol,
    operation: decl.operation.symbol,
  },
  name: effectOperationKeyFromDecl({
    effectName: decl.effect.name,
    opName: decl.operation.name,
    params: decl.operation.parameters,
  }),
});

export const freshOpenEffectRow = (
  effects: EffectTable,
  options?: { rigid?: boolean },
): EffectRowId =>
  effects.internRow({
    operations: [],
    tailVar: effects.freshTailVar({ rigid: options?.rigid }),
  });

export const composeEffectRows = (
  effects: EffectTable,
  rows: readonly EffectRowId[],
): EffectRowId =>
  rows.reduce((acc, row) => effects.compose(acc, row), pureEffectRow(effects));

export const constrainFunctionEffectRows = ({
  actual,
  expected,
  effects,
  ctx,
}: {
  actual: EffectRowId;
  expected: EffectRowId;
  effects: EffectTable;
  ctx: UnificationContext;
}): UnificationResult => {
  const actualRow = effects.getRow(actual);
  const expectedRow = effects.getRow(expected);
  const formatOps = (ops: readonly EffectOp[]): string =>
    ops.map(formatEffectOp).join(", ");

  const actualOps = new Set(actualRow.operations.map(effectOpRowKey));
  const expectedOps = new Set(expectedRow.operations.map(effectOpRowKey));
  const missingRequired = expectedRow.operations.filter(
    (op) => !actualOps.has(effectOpRowKey(op)),
  );
  const extraActual = actualRow.operations.filter(
    (op) => !expectedOps.has(effectOpRowKey(op)),
  );

  const actualCanSpecialize = Boolean(
    actualRow.tailVar && !actualRow.tailVar.rigid,
  );
  const expectedAllowsExtra = Boolean(
    expectedRow.tailVar && !expectedRow.tailVar.rigid,
  );
  const substitution = new Map<number, EffectRowId>();

  if (missingRequired.length > 0 && !actualCanSpecialize) {
    return {
      ok: false,
      conflict: {
        left: actual,
        right: expected,
        message: `missing required effects (${ctx.reason}): ${formatOps(missingRequired)}`,
      },
    };
  }

  if (extraActual.length > 0 && !expectedAllowsExtra) {
    return {
      ok: false,
      conflict: {
        left: actual,
        right: expected,
        message: `unexpected effects (${ctx.reason}): ${formatOps(extraActual)}`,
      },
    };
  }

  const needsSharedTail =
    actualCanSpecialize &&
    expectedAllowsExtra &&
    (missingRequired.length > 0 || extraActual.length > 0);
  const sharedTail = needsSharedTail ? effects.freshTailVar() : undefined;

  if (actualCanSpecialize) {
    if (
      missingRequired.length > 0 ||
      !expectedRow.tailVar ||
      expectedRow.tailVar.rigid ||
      sharedTail
    ) {
      substitution.set(
        actualRow.tailVar!.id,
        effects.internRow({
          operations: missingRequired,
          tailVar: sharedTail,
        }),
      );
    }
  }

  if (expectedAllowsExtra) {
    substitution.set(
      expectedRow.tailVar!.id,
      extraActual.length > 0 || sharedTail
        ? effects.internRow({
            operations: extraActual,
            tailVar:
              sharedTail ??
              (actualRow.tailVar &&
              actualRow.tailVar.id !== expectedRow.tailVar?.id
                ? actualRow.tailVar
                : undefined),
          })
        : actualRow.tailVar
          ? effects.internRow({ operations: [], tailVar: actualRow.tailVar })
          : effects.emptyRow,
    );
  }

  if (
    actualRow.tailVar &&
    (!expectedRow.tailVar || expectedRow.tailVar.rigid)
  ) {
    if (actualRow.tailVar.rigid) {
      return {
        ok: false,
        conflict: {
          left: actual,
          right: expected,
          message: `effect row is too open (${ctx.reason})`,
        },
      };
    }
    if (!substitution.has(actualRow.tailVar.id)) {
      substitution.set(actualRow.tailVar.id, effects.emptyRow);
    }
  }

  return { ok: true, substitution: { rows: substitution } };
};

export const getExprEffectRow = (
  expr: HirExprId,
  ctx: TypingContext,
): EffectRowId => ctx.effects.getExprEffect(expr) ?? pureEffectRow(ctx.effects);

export const effectOpForSymbol = (
  symbol: SymbolId,
  ctx: TypingContext,
): EffectOp => {
  const record = ctx.symbolTable.getSymbol(symbol);
  const ownerEffect = (
    record.metadata as { ownerEffect?: SymbolId } | undefined
  )?.ownerEffect;
  const resolved = resolvedEffectOperationDeclFor({ symbol, ctx });
  if (resolved) {
    return effectOpFromDecl(resolved);
  }

  const effectName =
    typeof ownerEffect === "number"
      ? ctx.symbolTable.getSymbol(ownerEffect).name
      : undefined;
  const imported = importedTargetFor({ symbol, ctx });
  return {
    identity: {
      moduleId: imported?.moduleId ?? ctx.moduleId,
      effect: ownerEffect ?? imported?.symbol ?? symbol,
      operation: imported?.symbol ?? symbol,
    },
    name: effectName ? `${effectName}.${record.name}` : record.name,
  };
};

export const effectOpName = (symbol: SymbolId, ctx: TypingContext): string =>
  effectOpForSymbol(symbol, ctx).name;

const resolveEffectAnnotationSymbol = (
  expr: HirNamedTypeExpr,
  ctx: TypingContext,
): SymbolId | undefined => {
  const name = expr.path[0];
  const explicit = typeof expr.symbol === "number" ? expr.symbol : undefined;
  if (typeof explicit === "number") {
    const kind = ctx.symbolTable.getSymbol(explicit).kind;
    if (kind === "effect" || kind === "effect-op") {
      return explicit;
    }
  }

  if (name) {
    const byKind = ctx.symbolTable.resolveByKinds(
      name,
      ctx.symbolTable.rootScope,
      ["effect", "effect-op"],
    );
    if (typeof byKind === "number") {
      return byKind;
    }
  }

  if (typeof explicit === "number") {
    return explicit;
  }

  if (!name) {
    return undefined;
  }
  return ctx.symbolTable.resolve(name, ctx.symbolTable.rootScope);
};

const resolveNamedEffectRow = (
  expr: HirNamedTypeExpr,
  ctx: TypingContext,
): EffectRowId => {
  if (
    expr.path.length === 1 &&
    expr.path[0] === "open" &&
    typeof expr.symbol !== "number"
  ) {
    return freshOpenEffectRow(ctx.effects);
  }

  const symbol = resolveEffectAnnotationSymbol(expr, ctx);
  if (typeof symbol !== "number") {
    return pureEffectRow(ctx.effects);
  }

  const record = ctx.symbolTable.getSymbol(symbol);
  if (record.kind === "effect") {
    const localDecl = ctx.decls.getEffect(symbol);
    const imported = localDecl ? undefined : importedTargetFor({ symbol, ctx });
    const importedDecl = imported
      ? ctx.dependencies
          .get(imported.moduleId)
          ?.decls.getEffect(imported.symbol)
      : undefined;
    const decl = localDecl ?? importedDecl;
    const moduleId = localDecl ? ctx.moduleId : imported?.moduleId;
    const ops =
      decl && moduleId
        ? decl.operations.map((operation) =>
            effectOpFromDecl({
              decl: { effect: decl, operation },
              moduleId,
            }),
          )
        : [];
    return ctx.effects.internRow({ operations: ops });
  }

  if (record.kind === "effect-op") {
    return ctx.effects.internRow({
      operations: [effectOpForSymbol(symbol, ctx)],
    });
  }

  return freshOpenEffectRow(ctx.effects);
};

const resolveEffectRowFromExpr = (
  effectType: HirTypeExpr,
  ctx: TypingContext,
  state: TypingState,
): EffectRowId => {
  const compose = (types: readonly HirTypeExpr[]): EffectRowId =>
    composeEffectRows(
      ctx.effects,
      types.map((type) => resolveEffectRowFromExpr(type, ctx, state)),
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
  state: TypingState,
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

  const backward = ctx.effects.constrain(annotated, inferred, {
    location,
    reason,
  });
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
