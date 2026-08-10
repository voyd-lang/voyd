import type binaryen from "binaryen";
import type { CodegenContext, FunctionContext } from "../../context.js";
import { ensureMsgPackProviderFunctions } from "../../host-transport/providers/msgpack.js";
import type { BoundarySchema } from "../../boundary/schema.js";
import { deriveBoundarySchema } from "../../boundary/schema.js";
import {
  readDtoValueFromTree,
  writeDtoValueToTree,
} from "../../boundary/dto-tree-codec.js";

export const packMsgPackValueForType = ({
  value,
  typeId,
  msgpack,
  ctx,
  fnCtx,
  label,
  schema,
}: {
  value: binaryen.ExpressionRef;
  typeId: number;
  msgpack: ReturnType<typeof ensureMsgPackProviderFunctions>;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  label: string;
  schema?: BoundarySchema;
}): binaryen.ExpressionRef =>
  writeDtoValueToTree({
    value,
    schema:
      schema ??
      deriveBoundarySchema({
        typeId,
        ctx,
        label,
      }),
    ctx,
    fnCtx,
    provider: msgpack,
  });

export const unpackMsgPackValueForType = ({
  value,
  typeId,
  msgpack,
  ctx,
  fnCtx,
  label,
  schema,
}: {
  value: binaryen.ExpressionRef;
  typeId: number;
  msgpack: ReturnType<typeof ensureMsgPackProviderFunctions>;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  label: string;
  schema?: BoundarySchema;
}): binaryen.ExpressionRef =>
  readDtoValueFromTree({
    value,
    schema:
      schema ??
      deriveBoundarySchema({
        typeId,
        ctx,
        label,
      }),
    ctx,
    fnCtx,
    provider: msgpack,
  });
