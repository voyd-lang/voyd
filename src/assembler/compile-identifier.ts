import { CompileExprOpts, mapBinaryenType } from "../assembler.js";
import { Identifier } from "../syntax-objects/identifier.js";
import { refCast } from "../lib/binaryen-gc/index.js";
import * as gc from "../lib/binaryen-gc/index.js";
import binaryen from "binaryen";

export const compile = (opts: CompileExprOpts<Identifier>) => {
  const { expr, mod } = opts;

  if (expr.is("break")) return mod.br(opts.loopBreakId!);

  const entity = expr.resolve();
  if (!entity) {
    throw new Error(`Unrecognized symbol ${expr.value}`);
  }

  if (entity.isVariable() || entity.isParameter()) {
    if (opts.currentClosure?.captureMap.has(entity.id)) {
      const captureIndex = opts.currentClosure.captureMap.get(entity.id)!;
      const envRef = refCast(
        mod,
        mod.local.get(0, binaryen.eqref),
        opts.currentClosure.envType
      );
      return gc.structGetFieldValue({
        mod,
        fieldIndex: captureIndex,
        fieldType: mapBinaryenType(opts, entity.originalType ?? entity.type!),
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

