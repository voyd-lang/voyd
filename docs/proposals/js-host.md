# JS Host Package

Status: Draft  
Owner: Runtime + Tooling  
Scope: `packages/js-host`

## Overview

We should extract the JS host glue (effect table parsing, dispatch loop, wasm
setup) into a dedicated package to make embedding Voyd in JS applications easy.
This package is a thin implementation of the host protocol.

See `docs/specs/host-protocol.md` for the wire format and ABI details.

## Goals

- Single, ergonomic API for JS hosts.
- No dependency on `@voyd/compiler`.
- Protocol surface is reusable by other hosts (Rust, etc.).

## Package Location

`packages/js-host`

Suggested npm name: `@voyd/js-host`.

## Proposed File Layout

```
packages/js-host/
  src/
    protocol/
      table.ts        // parse effect table, signature hashes, op_index
      types.ts        // HostProtocol types
    runtime/
      memory.ts       // linear memory helpers
      dispatch.ts     // request/resume loop
    host.ts           // createVoydHost API
  package.json
  tsconfig.json
  README.md
```

## API Surface (Sketch)

```ts
export type EffectId = string;
export type OpId = number;
export type SignatureHash = string;
export type Handle = number;

export type EffectHandler = (...args: unknown[]) => unknown | Promise<unknown>;

export type EffectDescriptor = {
  opIndex: number;
  effectId: EffectId;
  opId: OpId;
  resumeKind: "resume" | "tail";
  signatureHash: SignatureHash;
  label?: string;
};

export type HostProtocolTable = {
  version: number;
  ops: EffectDescriptor[];
};

export type HostInitOptions = {
  wasm: Uint8Array | WebAssembly.Module;
  imports?: WebAssembly.Imports;
  bufferSize?: number;
};

export type VoydHost = {
  table: HostProtocolTable;
  instance: WebAssembly.Instance;
  registerHandler: (
    effectId: EffectId,
    opId: OpId,
    signatureHash: SignatureHash,
    handler: EffectHandler
  ) => void;
  initEffects: () => void;
  runPure: <T = unknown>(
    entryName: string,
    args?: unknown[]
  ) => Promise<T>;
  runEffectful: <T = unknown>(
    entryName: string,
    args?: unknown[]
  ) => Promise<T>;
  run: <T = unknown>(
    entryName: string,
    args?: unknown[]
  ) => Promise<T>;
};

export const createVoydHost: (opts: HostInitOptions) => Promise<VoydHost>;
```

## Example Usage

```ts
const host = await createVoydHost({ wasm });
host.registerHandler("com.acme.log", 0, "0x91f2...", (msg) => {
  console.log(msg);
});
host.initEffects();
const result = await host.run("main");
```

## Multi-Host Support

- The wire format is defined in `docs/specs/host-protocol.md`.
- `packages/js-host` implements that spec in JS.
- Other hosts (Rust, etc.) implement the same spec without sharing code.

## Compiler Test Use

Compiler tests can import `@voyd/js-host` as a **dev dependency** without
introducing a runtime dependency on the host library. The JS host must **not**
depend on `@voyd/compiler` to avoid a circular dependency.

## Migration Notes

- Move the effect host loop used in `apps/cli/src/test-runner.ts` into
  `@voyd/js-host` and have the CLI call the shared API.

## Run Semantics

- `runPure` calls the exported function directly (no effect loop).
- `runEffectful` uses the effect loop and expects `entryName_effectful`.
- `run` auto-detects:
  - If `entryName_effectful` exists, use effectful path.
  - Otherwise, fall back to pure.
