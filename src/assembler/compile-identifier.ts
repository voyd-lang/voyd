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
    const capturedIndex = opts.closureContext?.capturedFieldIndices.get(entity);
    if (capturedIndex !== undefined) {
      const envType = opts.closureContext!.envType;
      const envRef = mod.local.get(0, envType);
      return structGetFieldValue({
        mod,
        fieldType: mapBinaryenType(opts, entity.originalType ?? entity.type!),
        fieldIndex: capturedIndex,
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

