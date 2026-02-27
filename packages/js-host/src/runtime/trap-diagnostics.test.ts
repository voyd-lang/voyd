import { describe, expect, it } from "vitest";
import {
  createVoydTrapDiagnostics,
  isVoydRuntimeError,
} from "./trap-diagnostics.js";

const EMPTY_WASM_MODULE = new WebAssembly.Module(
  Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00)
);

const withStack = (error: Error, stack: string): Error => {
  Object.defineProperty(error, "stack", {
    value: stack,
    configurable: true,
  });
  return error;
};

describe("createVoydTrapDiagnostics", () => {
  it("detects wasm traps from Firefox/WebKit-style stack frames", () => {
    const diagnostics = createVoydTrapDiagnostics({ module: EMPTY_WASM_MODULE });
    const error = withStack(
      new Error("divide by zero"),
      [
        "RuntimeError: divide by zero",
        "worker@wasm://wasm/00112233:1:57",
        "run@https://example.test/app.js:20:3",
      ].join("\n")
    );

    const annotated = diagnostics.annotateTrap(error);
    expect(isVoydRuntimeError(annotated)).toBe(true);
    if (!isVoydRuntimeError(annotated)) {
      throw new Error("expected annotated error to be a voyd runtime error");
    }
    expect(annotated.voyd.kind).toBe("wasm-trap");
    expect(annotated.voyd.trap.wasmByteOffset).toBe(57);
  });

  it("does not annotate non-wasm runtime errors", () => {
    const diagnostics = createVoydTrapDiagnostics({ module: EMPTY_WASM_MODULE });
    const error = withStack(
      new Error("runtime error"),
      [
        "RuntimeError: runtime error",
        "run@https://example.test/app.js:20:3",
      ].join("\n")
    );

    const annotated = diagnostics.annotateTrap(error);
    expect(isVoydRuntimeError(annotated)).toBe(false);
  });

  it("does not annotate when a wasm frame exists but is not the throwing frame", () => {
    const diagnostics = createVoydTrapDiagnostics({ module: EMPTY_WASM_MODULE });
    const error = withStack(
      new Error("runtime error"),
      [
        "RuntimeError: runtime error",
        "at boom (https://example.test/host.js:10:3)",
        "at main (wasm://wasm/00112233:1:57)",
      ].join("\n")
    );

    const annotated = diagnostics.annotateTrap(error);
    expect(isVoydRuntimeError(annotated)).toBe(false);
  });
});
