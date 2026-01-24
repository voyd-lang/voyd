import type binaryen from "binaryen";
import { dirname, resolve } from "node:path";
import {
  createVoydHost,
  formatSignatureHash,
  parseEffectTable,
  type ParsedEffectOp,
  type ParsedEffectTable,
} from "@voyd/js-host";
import type { Diagnostic } from "../../../diagnostics/index.js";
import type { CodegenOptions } from "../../context.js";
import { codegenProgram } from "../../codegen.js";
import { buildModuleGraph } from "../../../modules/graph.js";
import { createFsModuleHost } from "../../../modules/fs-host.js";
import type { ModuleGraph, ModuleNode } from "../../../modules/types.js";
import { analyzeModules } from "../../../pipeline-shared.js";
import { buildProgramCodegenView } from "../../../semantics/codegen-view/index.js";
import { monomorphizeProgram } from "../../../semantics/linking.js";

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

const STD_ROOT = resolve(import.meta.dirname, "../../../../../std/src");

const mergeGraphs = (graphs: ModuleGraph[]): ModuleGraph => {
  const modules = new Map<string, ModuleNode>();
  const diagnostics: Diagnostic[] = [];

  graphs.forEach((graph) => {
    graph.modules.forEach((node, id) => {
      if (!modules.has(id)) {
        modules.set(id, node);
      }
    });
    diagnostics.push(...graph.diagnostics);
  });

  return {
    entry: graphs[0]?.entry,
    modules,
    diagnostics,
  };
};

const toWasmBytes = (module: binaryen.Module): Uint8Array => {
  const binary = module.emitBinary();
  if (binary instanceof Uint8Array) {
    return binary;
  }
  return (
    (binary as { binary?: Uint8Array; output?: Uint8Array }).output ??
    (binary as { binary?: Uint8Array }).binary ??
    new Uint8Array()
  );
};

const throwIfErrors = (diagnostics: Diagnostic[]) => {
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    throw new Error(JSON.stringify(diagnostics, null, 2));
  }
};

export const compileEffectFixture = async ({
  entryPath,
  extraEntries,
  codegenOptions,
}: {
  entryPath: string;
  extraEntries?: readonly string[];
  codegenOptions?: CodegenOptions;
}) => {
  const host = createFsModuleHost();
  const srcRoot = dirname(entryPath);
  const roots = { src: srcRoot, std: STD_ROOT };

  const includeMsgpack =
    codegenOptions?.effectsHostBoundary !== "off";
  const msgpackEntry = includeMsgpack
    ? resolve(STD_ROOT, "msgpack.voyd")
    : undefined;
  const stringEntry = includeMsgpack
    ? resolve(STD_ROOT, "string.voyd")
    : undefined;
  const entrySet = new Set([
    entryPath,
    ...(extraEntries ?? []),
    ...(msgpackEntry ? [msgpackEntry] : []),
    ...(stringEntry ? [stringEntry] : []),
  ]);
  const graphs = await Promise.all(
    Array.from(entrySet).map((path) =>
      buildModuleGraph({ entryPath: path, host, roots })
    )
  );
  const graph = graphs.length > 1 ? mergeGraphs(graphs) : graphs[0]!;
  const { semantics, diagnostics: semanticDiagnostics } = analyzeModules({
    graph,
  });
  const diagnostics = [...graph.diagnostics, ...semanticDiagnostics];
  throwIfErrors(diagnostics);

  const modules = Array.from(semantics.values());
  const monomorphized = monomorphizeProgram({ modules, semantics });
  const program = buildProgramCodegenView(modules, {
    instances: monomorphized.instances,
    moduleTyping: monomorphized.moduleTyping,
  });
  const entryModuleId = graph.entry ?? entryPath;
  const result = codegenProgram({ program, entryModuleId, options: codegenOptions });
  const allDiagnostics = [...diagnostics, ...result.diagnostics];
  throwIfErrors(allDiagnostics);

  return {
    ...result,
    wasm: toWasmBytes(result.module),
    diagnostics: allDiagnostics,
    entryModuleId,
    graph,
    semantics,
    entrySemantics: semantics.get(entryModuleId),
  };
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

const isTestAssertionOp = (op: ParsedEffectOp): boolean =>
  op.effectId.endsWith("std::test::assertions::Test") ||
  op.label.startsWith("std::test::assertions::Test.");

const defaultTestAssertionHandler: EffectHandler = (request) => {
  throw new Error(`Unhandled std::test::assertions effect: ${request.label}`);
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
    const resolvedHandler =
      handler ?? (isTestAssertionOp(op) ? defaultTestAssertionHandler : undefined);
    if (!resolvedHandler) return;
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
      (...args) => resolvedHandler(request, ...args)
    );
  });

  const value = await host.runEffectful<T>(entryName);
  return { value, table, instance: host.instance };
};

export { parseEffectTable };
