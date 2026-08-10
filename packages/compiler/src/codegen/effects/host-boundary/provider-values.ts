import type binaryen from "binaryen";
import type { CodegenContext, FunctionContext } from "../../context.js";
import type { BoundarySchema } from "../../boundary/schema.js";
import { deriveBoundarySchema } from "../../boundary/schema.js";
import {
  readDtoValueFromTree,
  writeDtoValueToTree,
} from "../../boundary/dto-tree-codec.js";
import type { SelectedHostTransportProvider } from "../../host-transport/selected-provider.js";

export const writeProviderValueForType = ({
  value,
  typeId,
  provider,
  ctx,
  fnCtx,
  label,
  schema,
}: {
  value: binaryen.ExpressionRef;
  typeId: number;
  provider: SelectedHostTransportProvider;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  label: string;
  schema?: BoundarySchema;
}): binaryen.ExpressionRef =>
  writeDtoValueToTree({
    value,
    schema: schema ?? deriveBoundarySchema({ typeId, ctx, label }),
    ctx,
    fnCtx,
    provider,
  });

export const readProviderValueForType = ({
  value,
  typeId,
  provider,
  ctx,
  fnCtx,
  label,
  schema,
}: {
  value: binaryen.ExpressionRef;
  typeId: number;
  provider: SelectedHostTransportProvider;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  label: string;
  schema?: BoundarySchema;
}): binaryen.ExpressionRef =>
  readDtoValueFromTree({
    value,
    schema: schema ?? deriveBoundarySchema({ typeId, ctx, label }),
    ctx,
    fnCtx,
    provider,
  });
