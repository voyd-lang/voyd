import type { SymbolTable } from "../binder/index.js";
import type { HirFunction, HirGraph } from "../hir/index.js";
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
  Array.from(hir.items.values())
    .filter((item): item is HirFunction => item.kind === "function")
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
