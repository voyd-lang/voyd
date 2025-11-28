import { CompileExprOpts, mapBinaryenType } from "../codegen.js";
import { Identifier } from "../syntax-objects/identifier.js";
import { refCast, structGetFieldValue } from "@voyd/lib/binaryen-gc/index.js";
import { getClosureEnvType, getClosureSuperType } from "./compile-closure.js";

export const compile = (opts: CompileExprOpts<Identifier>) => {
  const { expr, mod } = opts;

  if (expr.is("break")) return mod.br(opts.loopBreakId!);
  if (expr.is("void")) return mod.nop();

  const entity = expr.resolve();
  if (!entity) {
    throw new Error(`Unrecognized symbol ${expr.value}`);
  }

  if (entity.isVariable() || entity.isParameter()) {
    if (expr.parentFn?.isClosure() && entity.parentFn !== expr.parentFn) {
      const closure = expr.parentFn;
      if (entity.isVariable() && entity.initializer === closure) {
        return mod.local.get(0, getClosureSuperType(mod));
      }
      const envType = getClosureEnvType(closure.syntaxId)!;
      const fieldIndex = closure.captures.indexOf(entity) + 1;
      return structGetFieldValue({
        mod,
        fieldType: mapBinaryenType(opts, entity.originalType ?? entity.type!),
        fieldIndex,
        exprRef: refCast(
          mod,
          mod.local.get(0, getClosureSuperType(mod)),
          envType
        ),
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
