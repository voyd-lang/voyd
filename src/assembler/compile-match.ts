import binaryen from "binaryen";
import { CompileExprOpts, compileExpression } from "../assembler.js";
import { Match, MatchCase } from "../syntax-objects/match.js";
import { compile as compileVariable } from "./compile-variable.js";
import { compile as compileIdentifier } from "./compile-identifier.js";
import { structGetFieldValue } from "../lib/binaryen-gc/index.js";

export const compile = (opts: CompileExprOpts<Match>) => {
  const { expr } = opts;

  const constructIfChain = (cases: MatchCase[]): number => {
    const nextCase = cases.shift();
    if (!nextCase) return opts.mod.unreachable();

    if (!cases.length) {
      return compileExpression({ ...opts, expr: nextCase.expr });
    }

    return opts.mod.if(
      opts.mod.call(
        "__extends",
        [
          opts.mod.i32.const(nextCase.matchType!.syntaxId),
          structGetFieldValue({
            mod: opts.mod,
            fieldType: opts.extensionHelpers.i32Array,
            fieldIndex: 0,
            exprRef: compileIdentifier({ ...opts, expr: expr.bindIdentifier }),
          }),
        ],
        binaryen.i32
      ),
      compileExpression({ ...opts, expr: nextCase.expr }),
      constructIfChain(cases)
    );
  };

  const ifChain = constructIfChain(
    expr.defaultCase ? [...expr.cases, expr.defaultCase] : expr.cases
  );

  if (expr.bindVariable) {
    return opts.mod.block(null, [
      compileVariable({
        ...opts,
        isReturnExpr: false,
        expr: expr.bindVariable,
      }),
      ifChain,
    ]);
  }

  return ifChain;
};

