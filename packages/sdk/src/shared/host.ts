import {
  createVoydHost,
  type EffectHandler,
  type HostInitOptions,
  type VoydHost,
} from "@voyd/js-host";
import type { RunOptions } from "./types.js";

const parseHandlerKey = (key: string): {
  effectId: string;
  opId: number;
  signatureHash: string;
} => {
  const parts = key.split(":");
  if (parts.length < 3) {
    throw new Error(
      `Invalid handler key ${key}. Expected effectId:opId:signatureHash`
    );
  }

  const signatureHash = parts.pop() ?? "";
  const opIdValue = parts.pop() ?? "";
  const effectId = parts.join(":");
  const opId = Number(opIdValue);

  if (!Number.isInteger(opId)) {
    throw new Error(`Invalid op id in handler key ${key}`);
  }

  return { effectId, opId, signatureHash };
};

export const registerHandlers = ({
  host,
  handlers,
}: {
  host: VoydHost;
  handlers: Record<string, EffectHandler>;
}): void => {
  Object.entries(handlers).forEach(([key, handler]) => {
    const { effectId, opId, signatureHash } = parseHandlerKey(key);
    host.registerHandler(effectId, opId, signatureHash, handler);
  });
};

export const createHost = (options: HostInitOptions): Promise<VoydHost> =>
  createVoydHost(options);

export const runWithHandlers = async <T = unknown>({
  wasm,
  entryName,
  handlers,
  imports,
  bufferSize,
}: RunOptions): Promise<T> => {
  const host = await createHost({ wasm, imports, bufferSize });
  if (handlers) {
    registerHandlers({ host, handlers });
  }
  return host.run<T>(entryName);
};
