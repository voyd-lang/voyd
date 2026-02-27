import { describe, expect, it } from "vitest";
import {
  createVoydTrapDiagnostics,
  isVoydRuntimeError,
} from "./trap-diagnostics.js";

const EMPTY_WASM_MODULE = new WebAssembly.Module(
  Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00)
);

const encodeVarUint32 = (value: number): number[] => {
  const bytes: number[] = [];
  let remaining = value >>> 0;
  do {
    const chunk = remaining & 0x7f;
    remaining >>>= 7;
    bytes.push(remaining === 0 ? chunk : chunk | 0x80);
  } while (remaining !== 0);
  return bytes;
};

const encodeCustomSection = ({
  name,
  payload,
}: {
  name: string;
  payload: Uint8Array;
}): Uint8Array => {
  const nameBytes = new TextEncoder().encode(name);
  const sectionPayload = Uint8Array.from([
    ...encodeVarUint32(nameBytes.length),
    ...nameBytes,
    ...payload,
  ]);
  return Uint8Array.from([
    0x00,
    ...encodeVarUint32(sectionPayload.length),
    ...sectionPayload,
  ]);
};

const moduleWithRuntimeDiagnostics = (): WebAssembly.Module => {
  const runtimeDiagnostics = {
    version: 1,
    functions: [
      {
        wasmName: "pure_trap",
        moduleId: "math",
        functionName: "pure_trap",
        span: {
          file: "runtime-trap-diagnostics.voyd",
          start: 1,
          end: 20,
          startLine: 3,
          startColumn: 7,
          endLine: 3,
          endColumn: 21,
        },
      },
    ],
  };
  const diagnosticsBytes = new TextEncoder().encode(
    JSON.stringify(runtimeDiagnostics)
  );
  const diagnosticsSection = encodeCustomSection({
    name: "voyd.runtime_diagnostics",
    payload: diagnosticsBytes,
  });
  return new WebAssembly.Module(
    Uint8Array.from([
      0x00,
      0x61,
      0x73,
      0x6d,
      0x01,
      0x00,
      0x00,
      0x00,
      ...diagnosticsSection,
    ])
  );
};

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

  it("maps Firefox/WebKit wasm frame names without relying on V8 frame syntax", () => {
    const diagnostics = createVoydTrapDiagnostics({
      module: moduleWithRuntimeDiagnostics(),
    });
    const error = withStack(
      new Error("divide by zero"),
      [
        "WebAssembly.RuntimeError: divide by zero",
        "pure_trap@wasm://wasm/00112233:1:57",
        "run@https://example.test/app.js:20:3",
      ].join("\n")
    );

    const annotated = diagnostics.annotateTrap(error);
    expect(isVoydRuntimeError(annotated)).toBe(true);
    if (!isVoydRuntimeError(annotated)) {
      throw new Error("expected annotated error to be a voyd runtime error");
    }
    expect(annotated.voyd.trap.wasmName).toBe("pure_trap");
    expect(annotated.voyd.trap.functionName).toBe("pure_trap");
    expect(annotated.voyd.trap.moduleId).toBe("math");
    expect(annotated.voyd.trap.span?.file).toBe("runtime-trap-diagnostics.voyd");
    expect(annotated.voyd.trap.span?.startLine).toBe(3);
    expect(annotated.voyd.trap.span?.startColumn).toBe(7);
  });
});
