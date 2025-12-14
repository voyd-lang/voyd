import binaryen from "binaryen";
import type { CodegenContext } from "../../context.js";
import type { MsgPackImports } from "./types.js";
import { stateFor } from "./state.js";

const READ_VALUE_KEY = Symbol("voyd.effects.hostBoundary.readValue");

export const createReadValue = ({
  ctx,
  imports,
  exportName = "read_value",
}: {
  ctx: CodegenContext;
  imports: MsgPackImports;
  exportName?: string;
}): string =>
  stateFor(ctx, READ_VALUE_KEY, () => {
    const name = `${ctx.moduleLabel}__read_value`;
    const params = binaryen.createType([binaryen.i32, binaryen.i32]);
    ctx.mod.addFunction(
      name,
      params,
      binaryen.i32,
      [],
      ctx.mod.call(
        imports.readValue,
        [ctx.mod.local.get(0, binaryen.i32), ctx.mod.local.get(1, binaryen.i32)],
        binaryen.i32
      )
    );
    ctx.mod.addFunctionExport(name, exportName);
    return name;
  });

