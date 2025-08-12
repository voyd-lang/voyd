import { CompileExprOpts, compileExpression, mapBinaryenType, getClosureBinaryenType } from "../assembler.js";
import { Closure, Expr, Variable, Parameter } from "../syntax-objects/index.js";
import * as gc from "../lib/binaryen-gc/index.js";
import binaryen from "binaryen";

const gatherCaptures = (
  expr: Expr | undefined,
  closure: Closure,
  captures: Map<string, Variable | Parameter>
) => {
  if (!expr) return;
  if (expr.isIdentifier()) {
    const entity = expr.resolve();
    if (
      entity &&
      (entity.isVariable() || entity.isParameter()) &&
      entity.parentFn !== closure
    ) {
      captures.set(entity.id, entity);
    }
    return;
  }
  if (expr.isClosure() || expr.isFn()) return;
  if (expr.isBlock()) {
    expr.body.forEach((e) => gatherCaptures(e, closure, captures));
    return;
  }
  if (expr.isCall()) {
    expr.args.each((a) => gatherCaptures(a, closure, captures));
    if (expr.typeArgs) expr.typeArgs.each((a) => gatherCaptures(a, closure, captures));
    return;
  }
  if (expr.isVariable()) {
    gatherCaptures(expr.initializer, closure, captures);
    if (expr.typeExpr) gatherCaptures(expr.typeExpr, closure, captures);
    return;
  }
  if (expr.isObjectLiteral()) {
    expr.fields.forEach((f) => gatherCaptures(f.initializer, closure, captures));
    return;
  }
  if (expr.isArrayLiteral()) {
    expr.elements.forEach((e) => gatherCaptures(e, closure, captures));
    return;
  }
  if (expr.isMatch()) {
    gatherCaptures(expr.operand, closure, captures);
    expr.cases.forEach((c) => gatherCaptures(c.expr, closure, captures));
    if (expr.defaultCase) gatherCaptures(expr.defaultCase.expr, closure, captures);
    return;
  }
};

export const compile = (opts: CompileExprOpts<Closure>): number => {
  const { expr: closure, mod } = opts;

  // Gather captures
  const captureMap = new Map<string, Variable | Parameter>();
  gatherCaptures(closure.body, closure, captureMap);
  const captures = Array.from(captureMap.values());
  const captureIndexMap = new Map<string, number>();
  captures.forEach((c, i) => captureIndexMap.set(c.id, i));

  // Environment struct type
  const envType = gc.defineStructType(mod, {
    name: `__closure_env_${closure.syntaxId}`,
    fields: captures.map((c) => ({
      type: mapBinaryenType(opts, c.type!),
      name: c.name.value,
    })),
    final: true,
  });

  // Compile body with closure context
  const body = compileExpression({
    ...opts,
    expr: closure.body,
    isReturnExpr: true,
    currentClosure: { envType, captureMap: captureIndexMap },
  });

  const params = [
    binaryen.eqref,
    ...closure.parameters.map((p) => mapBinaryenType(opts, p.type!)),
  ];
  const returnType = mapBinaryenType(opts, closure.getReturnType());
  const locals = closure.variables.map((v) => mapBinaryenType(opts, v.type!));
  const fnName = `__closure_${closure.syntaxId}`;

  mod.addFunction(
    fnName,
    binaryen.createType(params),
    returnType,
    locals,
    body
  );

  // Build environment struct instance
  const envValues = captures.map((c) => {
    const type = mapBinaryenType(opts, c.type!);
    if (c.isVariable()) return mod.local.get(c.getIndex(), type);
    if (c.isParameter()) return mod.local.get(c.getIndex(), type);
    return mod.nop();
  });
  const envStruct = gc.initStruct(mod, envType, envValues);

  const closureType = getClosureBinaryenType(mod);
  return gc.initStruct(mod, closureType, [
    gc.refFunc(mod, fnName, binaryen.funcref),
    envStruct,
  ]);
};

export default { compile };
