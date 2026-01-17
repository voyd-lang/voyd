import type binaryen from "binaryen";
import {
  createVoydHost,
  formatSignatureHash,
  parseEffectTable,
  type ParsedEffectOp,
  type ParsedEffectTable,
} from "@voyd/js-host";

export type EffectHandlerRequest = {
  handle: number;
  opIndex: number;
  effectId: string;
  effectIdHash: bigint;
  effectIdHashHex: string;
  opId: number;
  resumeKind: number;
  signatureHash: number;
  label: string;
};

export type EffectHandler = (
  request: EffectHandlerRequest,
  ...args: unknown[]
) => unknown | Promise<unknown>;

type WasmSource =
  | binaryen.Module
  | Uint8Array
  | ArrayBuffer
  | WebAssembly.Module;

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer;
  }

  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const toModule = (wasm: WasmSource): WebAssembly.Module => {
  if (wasm instanceof WebAssembly.Module) return wasm;
  if (wasm instanceof Uint8Array) {
    return new WebAssembly.Module(toArrayBuffer(wasm));
  }
  if (wasm instanceof ArrayBuffer) return new WebAssembly.Module(wasm);
  if (typeof (wasm as binaryen.Module).emitBinary === "function") {
    return new WebAssembly.Module(
      toArrayBuffer((wasm as binaryen.Module).emitBinary())
    );
  }
  throw new Error("Unsupported wasm input");
};

const resumeKindName = (value: number): string => (value === 1 ? "tail" : "resume");

const handlerKeyCandidates = (op: ParsedEffectOp): string[] => [
  `${op.opIndex}`,
  `${op.effectId}:${op.opId}:${op.signatureHash}`,
  `${op.effectId}:${op.opId}:${op.resumeKind}:${op.signatureHash}`,
  `${op.effectId}:${op.opId}:${op.resumeKind}`,
  `${op.effectIdHash.value.toString()}:${op.opId}:${op.signatureHash}`,
  `${op.effectIdHash.value.toString()}:${op.opId}:${op.resumeKind}:${op.signatureHash}`,
  `${op.effectIdHash.value.toString()}:${op.opId}:${op.resumeKind}`,
  `${op.effectIdHash.hex}:${op.opId}:${op.signatureHash}`,
  `${op.effectIdHash.hex}:${op.opId}:${op.resumeKind}:${op.signatureHash}`,
  `${op.effectIdHash.hex}:${op.opId}:${op.resumeKind}`,
  `${op.label}/${resumeKindName(op.resumeKind)}`,
  op.label,
];

const lookupHandler = (
  handlers: Record<string, EffectHandler> | undefined,
  op: ParsedEffectOp
): EffectHandler | undefined => {
  if (!handlers) return undefined;
  for (const key of handlerKeyCandidates(op)) {
    const handler = handlers[key];
    if (handler) return handler;
  }
  return undefined;
};

export const runEffectfulExport = async <T = unknown>({
  wasm,
  entryName,
  handlers,
  imports,
  bufferSize,
}: {
  wasm: WasmSource;
  entryName: string;
  handlers?: Record<string, EffectHandler>;
  imports?: WebAssembly.Imports;
  bufferSize?: number;
}): Promise<{
  value: T;
  table: ParsedEffectTable;
  instance: WebAssembly.Instance;
}> => {
  const module = toModule(wasm);
  const table = parseEffectTable(module);
  const host = await createVoydHost({ wasm: module, imports, bufferSize });

  table.ops.forEach((op) => {
    const handler = lookupHandler(handlers, op);
    if (!handler) return;
    const request: EffectHandlerRequest = {
      handle: op.opIndex,
      opIndex: op.opIndex,
      effectId: op.effectId,
      effectIdHash: op.effectIdHash.value,
      effectIdHashHex: op.effectIdHash.hex,
      opId: op.opId,
      resumeKind: op.resumeKind,
      signatureHash: op.signatureHash,
      label: op.label,
    };
    host.registerHandler(
      op.effectId,
      op.opId,
      formatSignatureHash(op.signatureHash),
      (...args) => handler(request, ...args)
    );
  });

  const value = await host.runEffectful<T>(entryName);
  return { value, table, instance: host.instance };
};

export { parseEffectTable };
