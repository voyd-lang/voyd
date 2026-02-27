const RUNTIME_DIAGNOSTICS_SECTION = "voyd.runtime_diagnostics";
const RUNTIME_DIAGNOSTICS_VERSION = 1;

type RuntimeDiagnosticsFunctionEntry = {
  wasmName: string;
  moduleId: string;
  functionName: string;
  span: VoydRuntimeSourceSpan;
};

type RuntimeDiagnosticsSection = {
  version: number;
  functions: RuntimeDiagnosticsFunctionEntry[];
};

type WasmStackFrame = {
  index?: number;
  byteOffset?: number;
  functionNameFromStack?: string;
};

export type VoydRuntimeSourceSpan = {
  file: string;
  start: number;
  end: number;
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
};

export type VoydRuntimeTrapSite = {
  wasmFunctionIndex?: number;
  wasmByteOffset?: number;
  wasmName?: string;
  moduleId?: string;
  functionName?: string;
  span?: VoydRuntimeSourceSpan;
};

export type VoydRuntimeEffectContext = {
  effectId: string;
  opId: number;
  opName: string;
  label: string;
  resumeKind: "resume" | "tail";
  continuationBoundary?: "resume" | "tail" | "end";
};

export type VoydRuntimeTransitionContext = {
  point: string;
  direction: "host->vm" | "vm->host" | "vm";
};

export type VoydRuntimeDiagnostics = {
  version: 1;
  kind: "wasm-trap";
  trap: VoydRuntimeTrapSite;
  effect?: VoydRuntimeEffectContext;
  transition?: VoydRuntimeTransitionContext;
};

export type VoydRuntimeError = Error & {
  voyd: VoydRuntimeDiagnostics;
};

export type VoydTrapAnnotation = {
  effect?: VoydRuntimeEffectContext;
  transition?: VoydRuntimeTransitionContext;
  fallbackFunctionName?: string;
};

export type VoydTrapDiagnostics = {
  annotateTrap: (error: unknown, annotation?: VoydTrapAnnotation) => Error;
};

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const readCustomSectionUtf8Json = <T>({
  module,
  sectionName,
}: {
  module: WebAssembly.Module;
  sectionName: string;
}): T | undefined => {
  const sections = WebAssembly.Module.customSections(module, sectionName);
  if (sections.length === 0) {
    return undefined;
  }
  const bytes = new Uint8Array(sections[0]!);
  const json = new TextDecoder().decode(bytes);
  return JSON.parse(json) as T;
};

const normalizeWasmName = (value: string): string =>
  value.startsWith("$") ? value.slice(1) : value;

const maybeBaseWasmName = (wasmName: string): string | undefined => {
  const strippedLeading = normalizeWasmName(wasmName);
  const suffixes = [
    "__effectful_impl",
    "__serialized_export_",
    "__wasm_export_",
  ];
  for (const suffix of suffixes) {
    const index = strippedLeading.indexOf(suffix);
    if (index > 0) {
      return strippedLeading.slice(0, index);
    }
  }
  return undefined;
};

const wasmNameCandidates = (raw: string): string[] => {
  const normalized = normalizeWasmName(raw);
  const base = maybeBaseWasmName(normalized);
  return base ? [normalized, base] : [normalized];
};

const parseRuntimeDiagnosticsSection = (
  module: WebAssembly.Module
): Map<string, RuntimeDiagnosticsFunctionEntry> => {
  let parsed: RuntimeDiagnosticsSection | undefined;
  try {
    parsed = readCustomSectionUtf8Json<RuntimeDiagnosticsSection>({
      module,
      sectionName: RUNTIME_DIAGNOSTICS_SECTION,
    });
  } catch {
    return new Map();
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    parsed.version !== RUNTIME_DIAGNOSTICS_VERSION ||
    !Array.isArray(parsed.functions)
  ) {
    return new Map();
  }

  const entries = new Map<string, RuntimeDiagnosticsFunctionEntry>();
  parsed.functions.forEach((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.wasmName !== "string" ||
      typeof entry.moduleId !== "string" ||
      typeof entry.functionName !== "string" ||
      !entry.span ||
      typeof entry.span.file !== "string" ||
      typeof entry.span.start !== "number" ||
      typeof entry.span.end !== "number"
    ) {
      return;
    }
    entries.set(normalizeWasmName(entry.wasmName), entry);
  });
  return entries;
};

const readVarUint32 = ({
  bytes,
  offset,
}: {
  bytes: Uint8Array;
  offset: number;
}): { value: number; nextOffset: number } => {
  let value = 0;
  let multiplier = 1;
  let cursor = offset;
  for (let index = 0; index < 5; index += 1) {
    if (cursor >= bytes.length) {
      throw new Error("Truncated varuint32");
    }
    const byte = bytes[cursor]!;
    cursor += 1;
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) {
      return { value, nextOffset: cursor };
    }
    multiplier *= 0x80;
  }
  throw new Error("Invalid varuint32");
};

const readUtf8String = ({
  bytes,
  offset,
}: {
  bytes: Uint8Array;
  offset: number;
}): { value: string; nextOffset: number } => {
  const lengthRead = readVarUint32({ bytes, offset });
  const end = lengthRead.nextOffset + lengthRead.value;
  if (end > bytes.length) {
    throw new Error("Truncated UTF-8 string");
  }
  const value = new TextDecoder().decode(
    bytes.subarray(lengthRead.nextOffset, end)
  );
  return { value, nextOffset: end };
};

const parseNameSectionFunctionNames = (
  module: WebAssembly.Module
): Map<number, string> => {
  try {
    const sections = WebAssembly.Module.customSections(module, "name");
    if (sections.length === 0) {
      return new Map();
    }
    const bytes = new Uint8Array(sections[0]!);
    const functionNames = new Map<number, string>();
    let offset = 0;
    while (offset < bytes.length) {
      const subsectionId = bytes[offset];
      if (subsectionId === undefined) {
        break;
      }
      offset += 1;
      const subsectionLengthRead = readVarUint32({ bytes, offset });
      offset = subsectionLengthRead.nextOffset;
      const subsectionEnd = offset + subsectionLengthRead.value;
      if (subsectionEnd > bytes.length) {
        break;
      }
      if (subsectionId !== 1) {
        offset = subsectionEnd;
        continue;
      }
      const payload = bytes.subarray(offset, subsectionEnd);
      let payloadOffset = 0;
      const countRead = readVarUint32({ bytes: payload, offset: payloadOffset });
      payloadOffset = countRead.nextOffset;
      for (let index = 0; index < countRead.value; index += 1) {
        const functionIndexRead = readVarUint32({
          bytes: payload,
          offset: payloadOffset,
        });
        payloadOffset = functionIndexRead.nextOffset;
        const nameRead = readUtf8String({
          bytes: payload,
          offset: payloadOffset,
        });
        payloadOffset = nameRead.nextOffset;
        functionNames.set(functionIndexRead.value, normalizeWasmName(nameRead.value));
      }
      offset = subsectionEnd;
    }
    return functionNames;
  } catch {
    return new Map();
  }
};

const parseWasmFrameFromLine = (line: string): WasmStackFrame | undefined => {
  const wasmMatch = line.match(/wasm-function\[(\d+)\](?::0x([0-9a-f]+))?/i);
  const wasmUrlMatch = line.match(/wasm:\/\/[^\s)]+:(\d+):(\d+)/i);
  if (!wasmMatch && !wasmUrlMatch) {
    return undefined;
  }

  const atMatch = line.trim().match(/^at\s+(.+?)\s+\(/);
  const fromStack = atMatch?.[1]?.trim();
  const functionNameFromStack =
    fromStack &&
    !fromStack.includes("<anonymous>") &&
    !fromStack.startsWith("null.") &&
    !fromStack.startsWith("wasm://") &&
    !fromStack.includes("wasm-function[")
      ? normalizeWasmName(fromStack)
      : undefined;
  const parsedIndex =
    wasmMatch?.[1] !== undefined
      ? Number.parseInt(wasmMatch[1], 10)
      : undefined;
  const byteOffsetFromIndex =
    wasmMatch?.[2] !== undefined
      ? Number.parseInt(wasmMatch[2], 16)
      : undefined;
  const byteOffsetFromUrl =
    wasmUrlMatch?.[2] !== undefined
      ? Number.parseInt(wasmUrlMatch[2], 10)
      : undefined;
  const byteOffset = Number.isFinite(byteOffsetFromIndex)
    ? byteOffsetFromIndex
    : byteOffsetFromUrl;
  return {
    index: Number.isFinite(parsedIndex) ? parsedIndex : undefined,
    byteOffset: Number.isFinite(byteOffset) ? byteOffset : undefined,
    functionNameFromStack,
  };
};

const parseWasmFrames = (stack?: string): WasmStackFrame[] => {
  if (!stack) {
    return [];
  }
  return stack
    .split("\n")
    .map(parseWasmFrameFromLine)
    .filter((frame): frame is WasmStackFrame => Boolean(frame));
};

const isWasmTrapError = (error: Error): boolean => {
  if (
    typeof WebAssembly !== "undefined" &&
    "RuntimeError" in WebAssembly &&
    error instanceof WebAssembly.RuntimeError
  ) {
    return true;
  }
  return /wasm-function\[\d+\]/i.test(error.stack ?? "");
};

const resolveFrame = ({
  frame,
  functionNamesByIndex,
  metadataByWasmName,
}: {
  frame: WasmStackFrame;
  functionNamesByIndex: Map<number, string>;
  metadataByWasmName: Map<string, RuntimeDiagnosticsFunctionEntry>;
}): {
  wasmName?: string;
  metadata?: RuntimeDiagnosticsFunctionEntry;
} => {
  const nameFromSection =
    typeof frame.index === "number"
      ? functionNamesByIndex.get(frame.index)
      : undefined;
  const rawName = nameFromSection ?? frame.functionNameFromStack;
  if (!rawName) {
    return {};
  }
  const resolved = wasmNameCandidates(rawName)
    .map((name) => ({
      wasmName: name,
      metadata: metadataByWasmName.get(name),
    }))
    .find((candidate) => candidate.metadata);
  if (resolved) {
    return resolved;
  }
  return { wasmName: normalizeWasmName(rawName) };
};

const buildDiagnostics = ({
  error,
  functionNamesByIndex,
  metadataByWasmName,
  metadataByFunctionName,
  annotation,
}: {
  error: Error;
  functionNamesByIndex: Map<number, string>;
  metadataByWasmName: Map<string, RuntimeDiagnosticsFunctionEntry>;
  metadataByFunctionName: Map<string, RuntimeDiagnosticsFunctionEntry>;
  annotation?: VoydTrapAnnotation;
}): VoydRuntimeDiagnostics => {
  const frames = parseWasmFrames(error.stack);
  const firstFrame = frames[0];
  const mappedFrame = frames.find((frame) => {
    const resolved = resolveFrame({
      frame,
      functionNamesByIndex,
      metadataByWasmName,
    });
    return Boolean(resolved.metadata);
  });
  const chosenFrame = mappedFrame ?? firstFrame;
  const resolved = chosenFrame
    ? resolveFrame({
        frame: chosenFrame,
        functionNamesByIndex,
        metadataByWasmName,
      })
    : undefined;
  const fallbackMetadata =
    annotation?.fallbackFunctionName
      ? metadataByFunctionName.get(annotation.fallbackFunctionName)
      : undefined;
  const trap: VoydRuntimeTrapSite = {
    ...(chosenFrame
      ? {
          ...(typeof chosenFrame.index === "number"
            ? { wasmFunctionIndex: chosenFrame.index }
            : {}),
          wasmByteOffset: chosenFrame.byteOffset,
        }
      : {}),
    ...(resolved?.wasmName ? { wasmName: resolved.wasmName } : {}),
    ...(resolved?.metadata
      ? {
          moduleId: resolved.metadata.moduleId,
          functionName: resolved.metadata.functionName,
          span: resolved.metadata.span,
        }
      : {}),
    ...(resolved?.metadata || !fallbackMetadata
      ? {}
      : {
          moduleId: fallbackMetadata.moduleId,
          functionName: fallbackMetadata.functionName,
          span: fallbackMetadata.span,
        }),
    ...(resolved?.metadata || !annotation?.fallbackFunctionName
      ? {}
      : { functionName: annotation.fallbackFunctionName }),
  };

  return {
    version: 1,
    kind: "wasm-trap",
    trap,
    ...(annotation?.effect ? { effect: annotation.effect } : {}),
    ...(annotation?.transition ? { transition: annotation.transition } : {}),
  };
};

const mergeDiagnostics = ({
  existing,
  next,
}: {
  existing: VoydRuntimeDiagnostics;
  next: VoydRuntimeDiagnostics;
}): VoydRuntimeDiagnostics => ({
  version: 1,
  kind: "wasm-trap",
  trap: {
    ...existing.trap,
    ...next.trap,
  },
  ...(existing.effect || next.effect
    ? { effect: next.effect ?? existing.effect }
    : {}),
  ...(existing.transition || next.transition
    ? { transition: next.transition ?? existing.transition }
    : {}),
});

export const isVoydRuntimeError = (error: unknown): error is VoydRuntimeError =>
  error instanceof Error &&
  typeof (error as { voyd?: unknown }).voyd === "object" &&
  (error as { voyd?: { kind?: unknown } }).voyd?.kind === "wasm-trap";

export const createVoydTrapDiagnostics = ({
  module,
}: {
  module: WebAssembly.Module;
}): VoydTrapDiagnostics => {
  const metadataByWasmName = parseRuntimeDiagnosticsSection(module);
  const metadataByFunctionName = new Map<string, RuntimeDiagnosticsFunctionEntry>();
  const ambiguousFunctionNames = new Set<string>();
  metadataByWasmName.forEach((entry) => {
    if (ambiguousFunctionNames.has(entry.functionName)) {
      return;
    }
    if (metadataByFunctionName.has(entry.functionName)) {
      metadataByFunctionName.delete(entry.functionName);
      ambiguousFunctionNames.add(entry.functionName);
      return;
    }
    metadataByFunctionName.set(entry.functionName, entry);
  });
  const functionNamesByIndex = parseNameSectionFunctionNames(module);
  return {
    annotateTrap: (error, annotation) => {
      const normalized = toError(error);
      if (!isWasmTrapError(normalized)) {
        return normalized;
      }
      const nextDiagnostics = buildDiagnostics({
        error: normalized,
        functionNamesByIndex,
        metadataByWasmName,
        metadataByFunctionName,
        annotation,
      });
      const withDiagnostics = normalized as VoydRuntimeError;
      withDiagnostics.voyd = isVoydRuntimeError(normalized)
        ? mergeDiagnostics({
            existing: normalized.voyd,
            next: nextDiagnostics,
          })
        : nextDiagnostics;
      return withDiagnostics;
    },
  };
};
