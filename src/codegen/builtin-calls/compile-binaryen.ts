import {
  CompileExprOpts,
  compileExpression,
  mapBinaryenType,
} from "../../codegen.js";
import { Call } from "../../syntax-objects/call.js";
import { Identifier } from "../../syntax-objects/identifier.js";
import { Expr } from "../../syntax-objects/expr.js";
import { getExprType } from "../../semantics/resolution/get-expr-type.js";
import * as gc from "@lib/binaryen-gc/index.js";

export const compileBinaryen = (opts: CompileExprOpts<Call>): number => {
  const { expr } = opts;
  const funcIdExpr = expr.labeledArg("func");
  const namespaceExpr = expr.labeledArg("namespace");
  const argsExpr = expr.labeledArg("args");

  if (!funcIdExpr?.isIdentifier())
    throw new Error("binaryen call missing 'func:' identifier");
  if (!namespaceExpr?.isIdentifier())
    throw new Error("binaryen call missing 'namespace:' identifier");
  if (!argsExpr?.isCall())
    throw new Error("binaryen call missing 'args:' list");

  const funcId = funcIdExpr as Identifier;
  const namespace = namespaceExpr.value;
  const args = argsExpr as Call; // Note: We don't actually care what this is calling, it can be foo for all we care. It just needs to be a call and shouldn't be type checked (yet)

  const func =
    namespace === "gc"
      ? (...args: unknown[]) => (gc as any)[funcId.value](opts.mod, ...args)
      : (opts.mod as any)[namespace][funcId.value];

  return func(
    ...(args.argArrayMap((expr: Expr) => {
      if (expr?.isCall() && expr.calls("BnrType")) {
        const type = getExprType(expr.typeArgs?.at(0));
        if (!type) return opts.mod.nop();
        return mapBinaryenType(opts, type);
      }

      if (expr?.isCall() && expr.calls("BnrConst")) {
        const arg = expr.argAt(0);
        if (!arg) return opts.mod.nop();
        // TODO: Standardize value
        if ("value" in arg) return arg.value;
      }

      return compileExpression({ ...opts, expr });
    }) ?? [])
  );
};
