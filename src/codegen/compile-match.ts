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
import { Type, Obj, UnionType } from "../syntax-objects/types.js";
import { structGetFieldValue } from "../lib/binaryen-gc/index.js";

export const compile = (opts: CompileExprOpts<Match>) => {
  const { expr, mod } = opts;
  const returnType = expr.type
    ? mapBinaryenType(opts, expr.type)
    : binaryen.none;
  const wrap = (e: number) =>
    returnType === binaryen.none ? asStmt(mod, e) : e;

  const getHeadKey = (t?: Type): string | undefined => {
    if (!t?.isObj()) return undefined;
    const obj = t as unknown as Obj;
    return obj.genericParent ? obj.genericParent.id : obj.id;
  };

  const base = expr.baseType as Type | undefined;
  const headCounts = new Map<string, number>();
  if (base?.isUnionType()) {
    const u = base as unknown as UnionType;
    u.resolvedMemberTypes.forEach((t) => {
      const key = getHeadKey(t as Type);
      if (!key) return;
      headCounts.set(key, (headCounts.get(key) ?? 0) + 1);
    });
  }

  const matchIdForCase = (t: Type | undefined): number => {
    if (!t) return 0;
    if (!t.isObj()) return t.syntaxId;
    const obj = t as unknown as Obj;
    const headKey = getHeadKey(t);
    const count = headKey ? headCounts.get(headKey) ?? 0 : 0;
    // If this head appears exactly once in the union, match by the head's
    // generic parent id so any instantiation is accepted (e.g., Array<T> in MsgPack);
    // otherwise, match by the concrete instantiation id to distinguish cases
    // like Box<Recursive> vs Box<i32>.
    if (count === 1 && obj.genericParent) return obj.genericParent.idNum;
    return t.syntaxId;
  };

  const constructIfChain = (cases: MatchCase[]): number => {
    const nextCase = cases.shift();
    if (!nextCase) return opts.mod.unreachable();

    if (!cases.length) {
      return wrap(compileExpression({ ...opts, expr: nextCase.expr }));
    }

    // Use the generic parent's id for generics (e.g., Array<T>, Map<T>) so
    // union matching recognizes any instantiation of the same nominal type.
    const cond = (() => {
      const id = matchIdForCase(nextCase.matchType);
      return opts.mod.call(
        "__extends",
        [
          opts.mod.i32.const(id),
          structGetFieldValue({
            mod: opts.mod,
            fieldType: opts.extensionHelpers.i32Array,
            fieldIndex: 0,
            exprRef: compileIdentifier({ ...opts, expr: expr.bindIdentifier }),
          }),
        ],
        binaryen.i32
      );
    })();
    return mod.if(
      cond,
      wrap(compileExpression({ ...opts, expr: nextCase.expr })),
      returnType === binaryen.none
        ? asStmt(mod, constructIfChain(cases))
        : constructIfChain(cases)
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
