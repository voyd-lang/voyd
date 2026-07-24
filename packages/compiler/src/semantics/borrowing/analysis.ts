import type { SymbolTable } from "../binder/index.js";
import {
  markCompilerPerfPhaseDuration,
  startCompilerPerfPhase,
} from "../../perf.js";
import {
  walkExpression,
  type HirExpression,
  type HirFunction,
  type HirGraph,
  type HirLambdaExpr,
} from "../hir/index.js";
import type { SymbolId } from "../ids.js";
import type { TypingResult } from "../typing/index.js";
import type { SymbolRef } from "../typing/symbol-ref.js";
import type { DeclTable } from "../decls.js";
import {
  analyzeFunctionBorrowing,
  analyzeLambdaBodyBorrowing,
} from "./body-analysis.js";
import type { BorrowingResult } from "./model.js";
import type { BorrowingDependency } from "./dependency.js";
import { computeCallableBorrowContracts } from "./summaries.js";
import {
  expressionTypeFor,
  resolveBorrowCall,
  type ResolveContext,
} from "./call-resolution.js";
import { typeCanCarryReference } from "./reference-bearing.js";

export const analyzeBorrowing = ({
  hir,
  typing,
  symbolTable,
  moduleId,
  imports,
  dependencies,
  decls,
}: {
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  moduleId: string;
  imports: readonly {
    local: SymbolId;
    target?: SymbolRef;
  }[];
  dependencies: ReadonlyMap<string, BorrowingDependency>;
  decls: DeclTable;
}): BorrowingResult => {
  const summariesStartedAt = startCompilerPerfPhase();
  const callables = computeCallableBorrowContracts({
    hir,
    typing,
    symbolTable,
    moduleId,
    imports,
    dependencies,
    decls,
  });
  markCompilerPerfPhaseDuration(
    "analyzeBorrowing.computeContracts",
    summariesStartedAt,
  );
  const facts: BorrowingResult["facts"][number][] = [];
  const diagnostics: BorrowingResult["diagnostics"][number][] = [];
  const importMap = new Map(
    imports.flatMap((entry) =>
      entry.target ? ([[entry.local, entry.target]] as const) : [],
    ),
  );
  const resolveContext: ResolveContext = {
    hir,
    typing,
    symbolTable,
    moduleId,
    imports: importMap,
    dependencies,
    contracts: callables,
    bindingInitializers: new Map(),
    callResolutionCache: new Map(),
    decls,
  };
  const selectionStartedAt = startCompilerPerfPhase();
  const functions = Array.from(hir.items.values())
    .filter((item): item is HirFunction => item.kind === "function")
    .filter((functionItem) =>
      bodyNeedsBorrowAnalysis({
        body: functionItem,
        hir,
        typing,
        resolveContext,
      }),
    );
  const lambdas = Array.from(hir.expressions.values()).filter(
    (expr): expr is HirLambdaExpr => expr.exprKind === "lambda",
  );
  markCompilerPerfPhaseDuration(
    "analyzeBorrowing.selectBodies",
    selectionStartedAt,
  );
  const bodiesStartedAt = startCompilerPerfPhase();
  functions.forEach((functionItem) =>
    analyzeFunctionBorrowing({
      functionItem,
      hir,
      typing,
      symbolTable,
      moduleId,
      imports: importMap,
      dependencies,
      decls,
      contracts: callables,
      facts,
      diagnostics,
    }),
  );
  lambdas.forEach((lambda) =>
    analyzeLambdaBodyBorrowing({
      lambda,
      hir,
      typing,
      symbolTable,
      moduleId,
      imports: importMap,
      dependencies,
      decls,
      contracts: callables,
      facts,
      diagnostics,
    }),
  );
  markCompilerPerfPhaseDuration(
    "analyzeBorrowing.checkBodies",
    bodiesStartedAt,
  );
  return { callables, facts, diagnostics };
};

// A body without both reference state and a borrow-producing or mutating
// operation cannot form an alias conflict. Unknown types and calls remain on
// the full-analysis path.
const bodyNeedsBorrowAnalysis = ({
  body,
  hir,
  typing,
  resolveContext,
}: {
  body: HirFunction;
  hir: HirGraph;
  typing: TypingResult;
  resolveContext: ResolveContext;
}): boolean => {
  let hasBorrowOperation = body.parameters.some(
    (parameter) => parameter.pattern.bindingKind === "mutable-ref",
  );
  let hasReferenceState = hasBorrowOperation;
  walkExpression({
    exprId: body.body,
    hir,
    options: { skipLambdas: true },
    onEnterExpression: (exprId, expression) => {
      if (
        expression.exprKind === "lambda" &&
        expression.captures.some((capture) => capture.mutable)
      ) {
        hasBorrowOperation = true;
        hasReferenceState = true;
        return { stop: true };
      }
      if (hasBorrowOperation && hasReferenceState) {
        return { stop: true };
      }
      if (expression.exprKind === "assign") {
        hasBorrowOperation = true;
      }
      const callAccess =
        expression.exprKind === "call" || expression.exprKind === "method-call"
          ? callBorrowAccess(expression, resolveContext)
          : undefined;
      if (callAccess?.access === "mutable") {
        hasBorrowOperation = true;
        hasReferenceState = true;
      }
      if (callAccess?.access === "shared" && callAccess.requiresAnalysis) {
        hasBorrowOperation = true;
      }
      if (
        expression.exprKind === "overload-set" ||
        isDeclaredCallableIdentifier(expression, typing)
      ) {
        return;
      }
      const typeId = expressionTypeFor(exprId, resolveContext);
      if (typeof typeId !== "number") {
        hasBorrowOperation = true;
        hasReferenceState = true;
        return { stop: true };
      }
      if (
        typing.arena.get(typeId).kind === "function" ||
        !typeCanCarryReference(typeId, typing)
      ) {
        return;
      }
      hasReferenceState = true;
      if (hasBorrowOperation) {
        return { stop: true };
      }
    },
    onEnterPattern: (pattern) => {
      if (
        pattern.bindingKind !== undefined &&
        pattern.bindingKind !== "value"
      ) {
        hasBorrowOperation = true;
        hasReferenceState = true;
        return { stop: true };
      }
    },
  });
  return hasBorrowOperation && hasReferenceState;
};

const callBorrowAccess = (
  expression: HirExpression,
  resolveContext: ResolveContext,
): {
  access: "mutable" | "shared" | "owned";
  requiresAnalysis: boolean;
} => {
  const contract = resolveBorrowCall(expression, resolveContext).contract;
  const parameters = contract?.parameters ?? [];
  const requiresAnalysis =
    contract?.maySuspend === true ||
    (contract?.scopedCallbacks?.length ?? 0) > 0 ||
    parameters.some((parameter) => parameter.retained || parameter.returned);
  if (parameters.some((parameter) => parameter.access === "mutable")) {
    return { access: "mutable", requiresAnalysis };
  }
  return {
    access: parameters.some((parameter) => parameter.access === "shared")
      ? "shared"
      : "owned",
    requiresAnalysis,
  };
};

const isDeclaredCallableIdentifier = (
  expression: HirExpression,
  typing: TypingResult,
): boolean =>
  expression.exprKind === "identifier" &&
  typing.functions.getSignature(expression.symbol) !== undefined;
