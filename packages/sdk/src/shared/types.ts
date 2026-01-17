import type { Diagnostic } from "@voyd/compiler/diagnostics/index.js";
import type { ModuleRoots } from "@voyd/compiler/modules/types.js";
import type { EffectHandler, HostInitOptions, VoydHost } from "@voyd/js-host";

export type { Diagnostic, EffectHandler, HostInitOptions, ModuleRoots, VoydHost };

export type CompileOptions = {
  entryPath?: string;
  source?: string;
  files?: Record<string, string>;
  roots?: ModuleRoots;
  includeTests?: boolean;
  optimize?: boolean;
  emitWasmText?: boolean;
};

export type CompileResult = {
  wasm: Uint8Array;
  wasmText?: string;
  diagnostics: Diagnostic[];
};

export type RunOptions = {
  wasm: Uint8Array;
  entryName: string;
  // handlers keyed as "effectId:opId:signatureHash"
  handlers?: Record<string, EffectHandler>;
  imports?: WebAssembly.Imports;
  bufferSize?: number;
};

export type VoydSdk = {
  compile: (opts: CompileOptions) => Promise<CompileResult>;
  createHost: (opts: HostInitOptions) => Promise<VoydHost>;
  run: <T = unknown>(opts: RunOptions) => Promise<T>;
};
