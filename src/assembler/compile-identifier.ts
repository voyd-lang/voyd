import binaryen from "binaryen";
import { CompileExprOpts, mapBinaryenType } from "../assembler.js";
import { Identifier } from "../syntax-objects/identifier.js";
import { refCast, structGetFieldValue } from "../lib/binaryen-gc/index.js";

export const compile = (opts: CompileExprOpts<Identifier>) => {
  const { expr, mod } = opts;

  if (expr.is("break")) return mod.br(opts.loopBreakId!);

  const entity = expr.resolve();
  if (!entity) {
    throw new Error(`Unrecognized symbol ${expr.value}`);
  }

  if (entity.isVariable() || entity.isParameter()) {
    if (expr.parentFn?.isClosure() && entity.parentFn !== expr.parentFn) {
      const closure = expr.parentFn;
      const closureType = closure.getAttribute("binaryenType") as number;
      const captureIndex = closure.captures.findIndex((c) => c === entity);
      const envRef = refCast(
        mod,
        mod.local.get(0, binaryen.eqref),
        closureType
      );
      return structGetFieldValue({
        mod,
        fieldType: mapBinaryenType(opts, entity.type!),
        fieldIndex: captureIndex + 1,
        exprRef: envRef,
      });
    }
    const type = mapBinaryenType(opts, entity.originalType ?? entity.type!);
    const get = mod.local.get(entity.getIndex(), type);
    if (entity.requiresCast) {
      return refCast(mod, get, mapBinaryenType(opts, entity.type!));
    }
    return get;
  }

  throw new Error(`Cannot compile identifier ${expr}`);
};

