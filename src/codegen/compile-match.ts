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
import { structGetFieldValue } from "../lib/binaryen-gc/index.js";

export const compile = (opts: CompileExprOpts<Match>) => {
  const { expr, mod } = opts;
  const returnType = expr.type ? mapBinaryenType(opts, expr.type) : binaryen.none;
  const wrap = (e: number) =>
    returnType === binaryen.none ? asStmt(mod, e) : e;

  const constructIfChain = (cases: MatchCase[]): number => {
    const nextCase = cases.shift();
    if (!nextCase) return opts.mod.unreachable();

    if (!cases.length) {
      return wrap(compileExpression({ ...opts, expr: nextCase.expr }));
    }

    return mod.if(
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
      wrap(compileExpression({ ...opts, expr: nextCase.expr })),
      returnType === binaryen.none ? asStmt(mod, constructIfChain(cases)) : constructIfChain(cases)
    );
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

