import type { SymbolTable } from "../binder/index.js";
import {
  walkExpression,
  type HirExpression,
  type HirFunction,
  type HirGraph,
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
  const callables = computeCallableBorrowContracts({
    hir,
    typing,
    symbolTable,
    moduleId,
    imports,
    dependencies,
    decls,
  });
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
    decls,
  };
  Array.from(hir.items.values())
    .filter((item): item is HirFunction => item.kind === "function")
    .filter((functionItem) =>
      functionNeedsBorrowAnalysis({
        functionItem,
        hir,
        typing,
        resolveContext,
      }),
    )
    .forEach((functionItem) =>
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
  Array.from(hir.expressions.values())
    .filter((expr) => expr.exprKind === "lambda")
    .forEach((lambda) =>
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
  return { callables, facts, diagnostics };
};

// A body without both reference state and a borrow-producing or mutating
// operation cannot form an alias conflict. Unknown types and calls remain on
// the full-analysis path.
const functionNeedsBorrowAnalysis = ({
  functionItem,
  hir,
  typing,
  resolveContext,
}: {
  functionItem: HirFunction;
  hir: HirGraph;
  typing: TypingResult;
  resolveContext: ResolveContext;
}): boolean => {
  let hasBorrowOperation = functionItem.parameters.some(
    (parameter) => parameter.pattern.bindingKind === "mutable-ref",
  );
  let hasReferenceState = hasBorrowOperation;
  walkExpression({
    exprId: functionItem.body,
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
        expression.exprKind === "call" ||
        expression.exprKind === "method-call"
          ? callBorrowAccess(expression, resolveContext)
          : "owned";
      if (callAccess === "mutable") {
        hasBorrowOperation = true;
        hasReferenceState = true;
      }
      if (callAccess === "shared") {
        hasBorrowOperation = true;
      }
      const typeId = expressionTypeFor(exprId, resolveContext);
      if (typeof typeId !== "number") {
        hasBorrowOperation = true;
        hasReferenceState = true;
        return { stop: true };
      }
      if (
        isDeclaredCallableIdentifier(expression, typeId, typing) ||
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
      if (pattern.bindingKind !== undefined && pattern.bindingKind !== "value") {
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
): "mutable" | "shared" | "owned" => {
  const parameters =
    resolveBorrowCall(expression, resolveContext).contract?.parameters ?? [];
  if (parameters.some((parameter) => parameter.access === "mutable")) {
    return "mutable";
  }
  return parameters.some((parameter) => parameter.access === "shared")
    ? "shared"
    : "owned";
};

const isDeclaredCallableIdentifier = (
  expression: HirExpression,
  typeId: number,
  typing: TypingResult,
): boolean =>
  expression.exprKind === "identifier" &&
  typing.arena.get(typeId).kind === "function" &&
  typing.functions.getSignature(expression.symbol) !== undefined;
