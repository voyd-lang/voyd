import binaryen from "binaryen";
import {
  CompileExprOpts,
  compileExpression,
  asStmt,
  mapBinaryenType,
} from "../codegen.js";
import { Match, MatchCase } from "../syntax-objects/match.js";
import { compile as compileVariable } from "./compile-variable.js";
import { compile as compileIdentifier } from "./compile-identifier.js";
import { refTest } from "../lib/binaryen-gc/index.js";

export const compile = (opts: CompileExprOpts<Match>) => {
  const { expr, mod } = opts;
  const returnType = expr.type ? mapBinaryenType(opts, expr.type) : binaryen.none;
  const wrap = (e: number) =>
    returnType === binaryen.none ? asStmt(mod, e) : e;

  const operandRef = compileIdentifier({ ...opts, expr: expr.bindIdentifier });

  const constructIfChain = (cases: MatchCase[]): number => {
    const nextCase = cases.shift();
    if (!nextCase) return opts.mod.unreachable();

    if (!cases.length) {
      return wrap(compileExpression({ ...opts, expr: nextCase.expr }));
    }

    const caseHeapType = mapBinaryenType(opts, nextCase.matchType!);
    const thenBranch = wrap(compileExpression({ ...opts, expr: nextCase.expr }));
    const elseBranch =
      returnType === binaryen.none
        ? asStmt(mod, constructIfChain(cases))
        : constructIfChain(cases);
    return mod.if(refTest(mod, operandRef, caseHeapType), thenBranch, elseBranch);
  };

  const ifChain = constructIfChain(
    expr.defaultCase ? [...expr.cases, expr.defaultCase] : expr.cases
  );

  if (expr.bindVariable) {
    const compiledVar = compileVariable({
      ...opts,
      isReturnExpr: false,
      expr: expr.bindVariable,
    });
    return mod.block(
      null,
      returnType === binaryen.none
        ? [asStmt(mod, compiledVar), asStmt(mod, ifChain)]
        : [asStmt(mod, compiledVar), ifChain],
      returnType === binaryen.none ? binaryen.none : binaryen.auto
    );
  }

  return returnType === binaryen.none ? asStmt(mod, ifChain) : ifChain;
};

