import type { HirExpression, HirGraph } from "../hir/index.js";
import type { HirExprId, SymbolId } from "../ids.js";
import type { SymbolTable } from "../binder/index.js";
import type { DeclTable } from "../decls.js";
import type {
  CallArgumentPlanEntry,
  TypingResult,
  FunctionSignature,
} from "../typing/index.js";
import type { SymbolRef } from "../typing/symbol-ref.js";
import type { BorrowingDependency } from "./dependency.js";
import type { CallableBorrowContract } from "./model.js";
import { mergeCallableBorrowContracts } from "./model.js";
import { typeCanCarryReference } from "./reference-bearing.js";

export type ResolvedBorrowCall = {
  target?: SymbolRef;
  targets: readonly SymbolRef[];
  signature?: Pick<
    FunctionSignature,
    "parameters" | "returnType" | "effectRow"
  >;
  contract?: CallableBorrowContract;
  arguments: readonly (HirExprId | undefined)[];
};

type BorrowCallSignature = Pick<
  FunctionSignature,
  "parameters" | "returnType" | "effectRow"
>;

const resolvedTypeFor = (
  exprId: HirExprId,
  typing: TypingResult,
  preferSymbolic = false,
): number | undefined => {
  const concrete =
    typing.resolvedExprTypes.get(exprId) ?? typing.table.getExprType(exprId);
  const symbolic = typing.borrowResolvedExprTypes.get(exprId);
  const direct = preferSymbolic ? (symbolic ?? concrete) : concrete;
  if (typeof direct === "number") {
    return direct;
  }
  const instantiated = Array.from(
    typing.functionInstanceExprTypes.values(),
  ).flatMap((types) => {
    const type = types.get(exprId);
    return typeof type === "number" ? [type] : [];
  });
  const instantiatedType =
    instantiated.find((type) => typeCanCarryReference(type, typing)) ??
    instantiated[0];
  return instantiatedType ?? symbolic;
};

const conservativeContractFor = (
  signature: BorrowCallSignature,
  typing: TypingResult,
): CallableBorrowContract => {
  const returnsReference = typeCanCarryReference(signature.returnType, typing);
  return {
    parameters: signature.parameters.map((parameter) => {
      const reference = typeCanCarryReference(parameter.type, typing);
      return {
        access:
          parameter.bindingKind === "mutable-ref"
            ? "mutable"
            : reference
              ? "shared"
              : "owned",
        retained: reference,
        returned: reference && returnsReference,
      };
    }),
    maySuspend: !typing.effects.isEmpty(signature.effectRow),
  };
};

const opaqueCallableFor = (
  expr: HirExpression,
  ctx: ResolveContext,
): {
  signature?: BorrowCallSignature;
  contract?: CallableBorrowContract;
} => {
  if (expr.exprKind !== "call") {
    return {};
  }
  const callee = ctx.hir.expressions.get(expr.callee);
  if (callee?.exprKind === "identifier") {
    const metadata = ctx.symbolTable.getSymbol(callee.symbol).metadata as
      | { intrinsic?: boolean }
      | undefined;
    if (metadata?.intrinsic === true) {
      return {};
    }
  }
  const typeId = resolvedTypeFor(
    expr.callee,
    ctx.typing,
    ctx.borrowIndexMode === "symbolic",
  );
  if (typeof typeId !== "number") {
    return {};
  }
  const descriptor = ctx.typing.arena.get(typeId);
  if (descriptor.kind !== "function") {
    return {};
  }
  const signature: BorrowCallSignature = {
    parameters: descriptor.parameters,
    returnType: descriptor.returnType,
    effectRow: descriptor.effectRow,
  };
  return {
    signature,
    contract: conservativeContractFor(signature, ctx.typing),
  };
};

const isIntrinsicCall = (expr: HirExpression, ctx: ResolveContext): boolean => {
  if (expr.exprKind !== "call") {
    return false;
  }
  const callee = ctx.hir.expressions.get(expr.callee);
  if (callee?.exprKind !== "identifier") {
    return false;
  }
  return (
    (
      ctx.symbolTable.getSymbol(callee.symbol).metadata as
        | { intrinsic?: boolean }
        | undefined
    )?.intrinsic === true && !ctx.decls.getEffectOperation(callee.symbol)
  );
};

const intrinsicNameForCall = (
  expr: HirExpression,
  ctx: ResolveContext,
): string | undefined => {
  if (expr.exprKind !== "call") {
    return undefined;
  }
  const callee = ctx.hir.expressions.get(expr.callee);
  if (callee?.exprKind !== "identifier") {
    return undefined;
  }
  const record = ctx.symbolTable.getSymbol(callee.symbol);
  const metadata = record.metadata as
    | { intrinsic?: boolean; intrinsicName?: string }
    | undefined;
  return metadata?.intrinsic === true &&
    !ctx.decls.getEffectOperation(callee.symbol)
    ? (metadata.intrinsicName ?? record.name)
    : undefined;
};

export type ResolveContext = {
  hir: HirGraph;
  symbolTable: SymbolTable;
  decls: DeclTable;
  typing: TypingResult;
  moduleId: string;
  imports: ReadonlyMap<SymbolId, SymbolRef>;
  dependencies: ReadonlyMap<string, BorrowingDependency>;
  contracts: ReadonlyMap<SymbolId, CallableBorrowContract>;
  bindingInitializers: ReadonlyMap<SymbolId, HirExprId>;
  borrowIndexMode?: "concrete" | "symbolic";
};

const isExplicitMutableBorrow = (
  exprId: HirExprId,
  ctx: ResolveContext,
): boolean => {
  const expr = ctx.hir.expressions.get(exprId);
  if (expr?.exprKind !== "call") {
    return false;
  }
  const callee = ctx.hir.expressions.get(expr.callee);
  if (callee?.exprKind !== "identifier") {
    return false;
  }
  const record = ctx.symbolTable.getSymbol(callee.symbol);
  const metadata = record.metadata as
    | { intrinsic?: boolean; intrinsicName?: string }
    | undefined;
  return (
    metadata?.intrinsic === true &&
    (metadata.intrinsicName ?? record.name) === "~"
  );
};

const targetMaySuspend = (target: SymbolRef, ctx: ResolveContext): boolean => {
  if (target.moduleId === ctx.moduleId) {
    return (
      ctx.decls.getEffectOperation(target.symbol)?.operation.resumable ===
      "resume"
    );
  }
  return (
    ctx.dependencies.get(target.moduleId)?.effectOperations.get(target.symbol)
      ?.maySuspend === true
  );
};

const conservativeContractForArguments = (
  expr: HirExpression,
  targets: readonly SymbolRef[],
  ctx: ResolveContext,
): CallableBorrowContract => {
  const actuals = argumentsFor(expr, undefined);
  const preferSymbolic = ctx.borrowIndexMode === "symbolic";
  const resultType = resolvedTypeFor(expr.id, ctx.typing, preferSymbolic);
  const returnsReference =
    typeof resultType !== "number" ||
    typeCanCarryReference(resultType, ctx.typing);
  return {
    parameters: actuals.map((actual) => {
      if (typeof actual !== "number") {
        return {
          access: "shared",
          retained: true,
          returned: returnsReference,
        };
      }
      const type = resolvedTypeFor(actual, ctx.typing, preferSymbolic);
      const reference =
        typeof type !== "number" || typeCanCarryReference(type, ctx.typing);
      return {
        access: isExplicitMutableBorrow(actual, ctx)
          ? "mutable"
          : reference
            ? "shared"
            : "owned",
        retained: reference,
        returned: reference && returnsReference,
      };
    }),
    maySuspend: targets.some((target) => targetMaySuspend(target, ctx)),
  };
};

const storageIntrinsicContract = ({
  name,
  argumentCount,
}: {
  name: string;
  argumentCount: number;
}): CallableBorrowContract | undefined => {
  if (name === "__array_copy" && argumentCount === 2) {
    return {
      parameters: Array.from({ length: argumentCount }, (_entry, index) => ({
        access: index === 0 ? "shared" : "owned",
        retained: false,
        returned: index === 0,
      })),
      transfers: [
        {
          sourceParameter: 1,
          destinationParameter: 0,
          sourcePath: [
            { kind: "field", name: "from" },
            { kind: "index", stable: false },
          ],
          destinationPath: [{ kind: "index", stable: false }],
        },
      ],
      maySuspend: false,
    };
  }
  if (name === "__array_copy" && argumentCount === 5) {
    return {
      parameters: Array.from({ length: argumentCount }, (_entry, index) => ({
        access: index === 0 || index === 2 ? "shared" : "owned",
        retained: false,
        returned: index === 0,
      })),
      transfers: [
        {
          sourceParameter: 2,
          destinationParameter: 0,
          sourcePath: [{ kind: "index", stable: false }],
          destinationPath: [{ kind: "index", stable: false }],
        },
      ],
      maySuspend: false,
    };
  }
  const storedValueIndex = name === "__array_set" ? 2 : undefined;
  if (typeof storedValueIndex !== "number") {
    return undefined;
  }
  return {
    parameters: Array.from({ length: argumentCount }, (_entry, index) => ({
      access: index === 0 || index === storedValueIndex ? "shared" : "owned",
      retained: index === storedValueIndex,
      returned: index === 0 || index === storedValueIndex,
    })),
    maySuspend: false,
  };
};

const uniqueTargets = (
  exprId: HirExprId,
  typing: TypingResult,
  preferSymbolic: boolean,
): readonly SymbolRef[] => {
  const concrete = [...(typing.callTargets.get(exprId)?.values() ?? [])];
  const symbolic = [...(typing.borrowCallTargets.get(exprId)?.values() ?? [])];
  const targets = preferSymbolic
    ? [...symbolic, ...concrete]
    : concrete.length > 0
      ? concrete
      : symbolic;
  if (targets.length === 0) {
    return [];
  }
  return Array.from(
    new Map<string, SymbolRef>(
      targets.map((target) => [`${target.moduleId}:${target.symbol}`, target]),
    ).values(),
  );
};

export const expressionTypeFor = (
  exprId: HirExprId,
  ctx: ResolveContext,
  seen = new Set<HirExprId>(),
): number | undefined => {
  const cached = resolvedTypeFor(
    exprId,
    ctx.typing,
    ctx.borrowIndexMode === "symbolic",
  );
  if (typeof cached === "number" || seen.has(exprId)) {
    return cached;
  }
  seen.add(exprId);
  const expression = ctx.hir.expressions.get(exprId);
  if (expression?.exprKind === "identifier") {
    const valueType = ctx.typing.valueTypes.get(expression.symbol);
    if (typeof valueType === "number") {
      return valueType;
    }
    const initializer = ctx.bindingInitializers.get(expression.symbol);
    if (typeof initializer === "number") {
      const initializerType = expressionTypeFor(initializer, ctx, seen);
      if (typeof initializerType === "number") {
        return initializerType;
      }
    }
    for (const [, signature] of ctx.typing.functions.signatures) {
      const parameter = signature.parameters.find(
        (candidate) => candidate.symbol === expression.symbol,
      );
      if (parameter) {
        return parameter.type;
      }
    }
    return undefined;
  }
  if (expression?.exprKind === "call") {
    const callee = ctx.hir.expressions.get(expression.callee);
    if (callee?.exprKind !== "identifier") {
      return undefined;
    }
    const imported = ctx.imports.get(callee.symbol);
    return imported
      ? ctx.dependencies.get(imported.moduleId)?.callables.get(imported.symbol)
          ?.signature?.returnType
      : ctx.typing.functions.getSignature(callee.symbol)?.returnType;
  }
  return undefined;
};

const directTarget = (
  expr: HirExpression,
  ctx: ResolveContext,
): SymbolRef | undefined => {
  if (expr.exprKind !== "call") {
    return undefined;
  }
  const callee = ctx.hir.expressions.get(expr.callee);
  if (callee?.exprKind !== "identifier") {
    return undefined;
  }
  const imported = ctx.imports.get(callee.symbol);
  if (imported) {
    return imported;
  }
  return ctx.typing.functions.getSignature(callee.symbol)
    ? {
        moduleId: ctx.moduleId,
        symbol: callee.symbol,
      }
    : undefined;
};

const alignExplicitArguments = (
  args: readonly { label?: string; expr: HirExprId }[],
  signature:
    | Pick<FunctionSignature, "parameters" | "returnType" | "effectRow">
    | undefined,
  offset: number,
): (HirExprId | undefined)[] => {
  if (!signature) {
    return args.map((argument) => argument.expr);
  }
  const result: (HirExprId | undefined)[] = Array(
    signature.parameters.length - offset,
  ).fill(undefined);
  let positional = 0;
  args.forEach((argument) => {
    if (argument.label) {
      const index = signature.parameters
        .slice(offset)
        .findIndex((parameter) => parameter.label === argument.label);
      if (index >= 0) {
        result[index] = argument.expr;
      }
      return;
    }
    while (result[positional] !== undefined) {
      positional += 1;
    }
    result[positional] = argument.expr;
    positional += 1;
  });
  return result;
};

const argumentsFor = (
  expr: HirExpression,
  signature:
    | Pick<FunctionSignature, "parameters" | "returnType" | "effectRow">
    | undefined,
): readonly (HirExprId | undefined)[] => {
  if (expr.exprKind === "method-call") {
    return [expr.target, ...alignExplicitArguments(expr.args, signature, 1)];
  }
  if (expr.exprKind === "call") {
    return alignExplicitArguments(expr.args, signature, 0);
  }
  return [];
};

const rawArgumentsFor = (expr: HirExpression): readonly HirExprId[] =>
  expr.exprKind === "method-call"
    ? [expr.target, ...expr.args.map((argument) => argument.expr)]
    : expr.exprKind === "call"
      ? expr.args.map((argument) => argument.expr)
      : [];

const argumentsFromPlan = (
  expr: HirExpression,
  plan: readonly CallArgumentPlanEntry[],
  hir: HirGraph,
): readonly (HirExprId | undefined)[] => {
  const raw = rawArgumentsFor(expr);
  return plan.map((entry) => {
    if (entry.kind === "direct") {
      return raw[entry.argIndex];
    }
    if (entry.kind === "container-field") {
      const container = raw[entry.containerArgIndex];
      if (typeof container !== "number") {
        return undefined;
      }
      const containerExpr = hir.expressions.get(container);
      if (containerExpr?.exprKind !== "object-literal") {
        return container;
      }
      return (
        containerExpr.entries.find(
          (candidate) =>
            candidate.kind === "field" && candidate.name === entry.fieldName,
        )?.value ?? container
      );
    }
    return undefined;
  });
};

const typedArgumentsFor = (
  expr: HirExpression,
  typing: TypingResult,
  hir: HirGraph,
  preferSymbolic: boolean,
): {
  arguments?: readonly (HirExprId | undefined)[];
  ambiguous: boolean;
} => {
  const concrete = [...(typing.callArgumentPlans.get(expr.id)?.values() ?? [])];
  const symbolic = [
    ...(typing.borrowCallArgumentPlans.get(expr.id)?.values() ?? []),
  ];
  const selected = preferSymbolic
    ? [...symbolic, ...concrete]
    : concrete.length > 0
      ? concrete
      : symbolic;
  const plans = selected.map((plan) => argumentsFromPlan(expr, plan, hir));
  if (plans.length === 0) {
    return { ambiguous: false };
  }
  const first = plans[0]!;
  const ambiguous = plans.some(
    (plan) => JSON.stringify(plan) !== JSON.stringify(first),
  );
  return ambiguous
    ? { arguments: rawArgumentsFor(expr), ambiguous: true }
    : { arguments: first, ambiguous: false };
};

export const resolveBorrowCall = (
  expr: HirExpression,
  ctx: ResolveContext,
): ResolvedBorrowCall => {
  const preferSymbolic = ctx.borrowIndexMode === "symbolic";
  const resolved = uniqueTargets(expr.id, ctx.typing, preferSymbolic);
  const direct = resolved.length === 0 ? directTarget(expr, ctx) : undefined;
  const inferred = resolved.length === 0 ? [...(direct ? [direct] : [])] : [];
  const targets = resolved.length > 0 ? resolved : inferred;
  const entries = targets.map((target) => {
    if (target.moduleId === ctx.moduleId) {
      return {
        target,
        signature: ctx.typing.functions.getSignature(target.symbol),
        contract: ctx.contracts.get(target.symbol),
      };
    }
    const callable = ctx.dependencies
      .get(target.moduleId)
      ?.callables.get(target.symbol);
    return {
      target,
      signature: callable?.signature,
      contract: callable?.contract,
    };
  });
  const typedArguments = typedArgumentsFor(
    expr,
    ctx.typing,
    ctx.hir,
    preferSymbolic,
  );
  const opaque = opaqueCallableFor(expr, ctx);
  const contracts = entries.flatMap((entry) => {
    if (entry.contract) {
      return [entry.contract];
    }
    const intrinsic =
      entry.target.moduleId === ctx.moduleId &&
      (
        ctx.symbolTable.getSymbol(entry.target.symbol).metadata as
          | { intrinsic?: boolean }
          | undefined
      )?.intrinsic === true &&
      !ctx.decls.getEffectOperation(entry.target.symbol);
    if (intrinsic) {
      const record = ctx.symbolTable.getSymbol(entry.target.symbol);
      const metadata = record.metadata as
        | { intrinsicName?: string }
        | undefined;
      const contract = storageIntrinsicContract({
        name: metadata?.intrinsicName ?? record.name,
        argumentCount:
          typedArguments.arguments?.length ?? rawArgumentsFor(expr).length,
      });
      if (contract) {
        return [contract];
      }
      return [];
    }
    const fallback =
      opaque.contract ??
      (entry.signature
        ? conservativeContractFor(entry.signature, ctx.typing)
        : conservativeContractForArguments(expr, [entry.target], ctx));
    return [fallback];
  });
  const entrySignatures = entries.flatMap((entry) =>
    entry.signature ? [entry.signature] : [],
  );
  const signatureKey = (signature: BorrowCallSignature): string =>
    JSON.stringify({
      parameters: signature.parameters.map((parameter) => ({
        type: parameter.type,
        label: parameter.label,
        bindingKind: parameter.bindingKind,
      })),
      returnType: signature.returnType,
      effectRow: signature.effectRow,
    });
  const signature =
    entrySignatures.length > 0 &&
    entrySignatures.every(
      (candidate) =>
        signatureKey(candidate) === signatureKey(entrySignatures[0]!),
    )
      ? entrySignatures[0]
      : opaque.signature;
  const intrinsicName = intrinsicNameForCall(expr, ctx);
  const intrinsicContract =
    typeof intrinsicName === "string"
      ? storageIntrinsicContract({
          name: intrinsicName,
          argumentCount:
            typedArguments.arguments?.length ?? rawArgumentsFor(expr).length,
        })
      : undefined;
  const unresolvedContract =
    intrinsicContract ??
    opaque.contract ??
    (!isIntrinsicCall(expr, ctx)
      ? conservativeContractForArguments(expr, [], ctx)
      : undefined);
  const contract = typedArguments.ambiguous
    ? conservativeContractForArguments(expr, targets, ctx)
    : mergeCallableBorrowContracts(
        targets.length > 0
          ? contracts
          : unresolvedContract
            ? [unresolvedContract]
            : [],
      );
  return {
    target: entries.length === 1 ? entries[0]?.target : undefined,
    targets,
    signature,
    contract,
    arguments:
      typedArguments.arguments ??
      (targets.length === 0 || direct
        ? argumentsFor(expr, signature)
        : rawArgumentsFor(expr)),
  };
};
