import binaryen from "binaryen";
import type { CodegenContext, FunctionMetadata } from "../../context.js";
import type { EffectRuntime } from "../runtime-abi.js";
import { ensureDispatcher } from "../dispatcher.js";

export const createEffectfulEntry = ({
  ctx,
  runtime,
  meta,
  handleOutcome,
  exportName,
}: {
  ctx: CodegenContext;
  runtime: EffectRuntime;
  meta: FunctionMetadata;
  handleOutcome: string;
  exportName: string;
}): string => {
  if (meta.paramTypes.length > 1) {
    throw new Error(
      `effectful exports with parameters are not supported yet (${exportName})`
    );
  }

  const name = `${ctx.moduleLabel}__${exportName}`;
  const params = binaryen.createType([binaryen.i32, binaryen.i32]);
  const dispatched = ctx.mod.call(
    ensureDispatcher(ctx),
    [
      ctx.mod.call(
        meta.wasmName,
        [ctx.mod.ref.null(runtime.handlerFrameType)],
        runtime.outcomeType
      ),
    ],
    runtime.outcomeType
  );
  ctx.mod.addFunction(
    name,
    params,
    runtime.effectResultType,
    [],
    ctx.mod.call(
      handleOutcome,
      [dispatched, ctx.mod.local.get(0, binaryen.i32), ctx.mod.local.get(1, binaryen.i32)],
      runtime.effectResultType
    )
  );
  ctx.mod.addFunctionExport(name, exportName);
  return name;
};

