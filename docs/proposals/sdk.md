# Voyd SDK Package

Status: Implemented
Owner: Tooling
Scope: `packages/sdk`

## Overview

We should provide a batteries-included SDK that exposes a single, ergonomic API
for compiling and running Voyd across Node, browser, and Deno. The SDK should
compose the compiler and JS host libraries while keeping them decoupled.

The SDK relies on the host protocol defined in `docs/specs/host-protocol.md`.

This proposal also migrates the current `packages/browser-compiler` into the
SDK as `@voyd/sdk/browser`.

## Goals

- One high-level entry point per environment.
- Consistent API shape across Node, browser, and Deno.
- Avoid circular dependencies (SDK depends on compiler + js-host).
- Preserve host-protocol independence for non-JS hosts.

## Non-Goals

- Replace `@voyd/compiler` or `@voyd/js-host` directly.
- Provide a Rust host implementation.

## Package Layout

```
packages/sdk/
  src/
    node.ts        // @voyd/sdk
    browser.ts     // @voyd/sdk/browser
    deno.ts        // @voyd/sdk/deno (stub initially)
    shared/
      types.ts
      compile.ts
      host.ts
  package.json
  tsconfig.json
```

## Entry Points

- `@voyd/sdk` (Node default)
  - Uses `@voyd/compiler` + fs host + `@voyd/js-host`.
- `@voyd/sdk/browser`
  - Uses browser compiler (migrated from `packages/browser-compiler`) +
    `@voyd/js-host` with browser-friendly wasm loading.
- `@voyd/sdk/deno`
  - Mirrors Node entry point with Deno IO adapters (initially minimal).

## Public API (Sketch)

```ts
export type VoydSdk = {
  compile: (opts: CompileOptions) => Promise<CompileResult>;
  createHost: (opts: HostInitOptions) => Promise<VoydHost>;
  run: <T = unknown>(opts: RunOptions) => Promise<T>;
};

export type CompileOptions = {
  entryPath?: string;
  source?: string;
  roots?: ModuleRoots;
  includeTests?: boolean;
};

export type CompileResult = {
  wasm: Uint8Array;
  diagnostics: Diagnostic[];
};

export type RunOptions = {
  wasm: Uint8Array;
  entryName: string;
  handlers?: Record<string, EffectHandler>;
  imports?: WebAssembly.Imports;
  bufferSize?: number;
};

export type VoydHost = {
  registerHandler: (
    effectId: string,
    opId: number,
    signatureHash: string,
    handler: EffectHandler
  ) => void;
  initEffects: () => void;
  runPure: <T = unknown>(entryName: string, args?: unknown[]) => Promise<T>;
  runEffectful: <T = unknown>(entryName: string, args?: unknown[]) => Promise<T>;
  run: <T = unknown>(entryName: string, args?: unknown[]) => Promise<T>;
};
```

## Example Usage (Node)

```ts
import { createSdk } from "@voyd/sdk";

const sdk = createSdk();
const { wasm } = await sdk.compile({ entryPath: "src/main.voyd" });

const host = await sdk.createHost({ wasm });
host.registerHandler("com.acme.log", 0, "0x91f2...", (msg) => console.log(msg));
host.initEffects();

const result = await host.run("main");
```

## Migration Plan

- Move `packages/browser-compiler` into `packages/sdk` and re-export it from
  `@voyd/sdk/browser`.
- Deprecate `@voyd/browser-compiler` with a migration notice.
- Update internal tests and examples to import from the SDK.

## Dependencies

SDK depends on:

- `@voyd/compiler` (or the browser variant for `@voyd/sdk/browser`)
- `@voyd/js-host`
- `@voyd/lib` helpers (wasm loader, std resolver)

The SDK should not be depended on by compiler or host packages.
