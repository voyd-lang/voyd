import {
  createVoydHost,
  registerHandlersByKey,
  type EffectHandler,
  type HostInitOptions,
  type VoydHost,
} from "@voyd-lang/js-host";
import type { RunOptions } from "./types.js";

export const createHost = (options: HostInitOptions): Promise<VoydHost> =>
  createVoydHost(options);

export const registerHandlers = ({
  host,
  handlers,
}: {
  host: VoydHost;
  handlers: Record<string, EffectHandler>;
}): void => {
  registerHandlersByKey({ host, handlers });
};

export const registerHandlersByLabelSuffix = ({
  host,
  handlersByLabelSuffix,
}: {
  host: VoydHost;
  handlersByLabelSuffix: Record<string, EffectHandler>;
}): void => {
  host.registerHandlersByLabelSuffix(handlersByLabelSuffix);
};

export const runWithHandlers = async <T = unknown>({
  wasm,
  entryName,
  handlers,
  handlersByLabelSuffix,
  imports,
  bufferSize,
  defaultAdapters,
  args,
}: RunOptions): Promise<T> => {
  const host = await createHost({ wasm, imports, bufferSize, defaultAdapters });
  if (handlersByLabelSuffix) {
    registerHandlersByLabelSuffix({ host, handlersByLabelSuffix });
  }
  if (handlers) {
    registerHandlers({ host, handlers });
  }
  return host.run<T>(entryName, args);
};
