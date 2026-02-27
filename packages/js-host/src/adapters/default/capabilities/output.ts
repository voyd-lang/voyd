import { flushNodeStream, writeToNodeStream } from "../io.js";
import { outputErrorCode, outputErrorMessage } from "../errors.js";
import {
  globalRecord,
  hostError,
  hostOk,
  normalizeByte,
  readField,
  toStringOrUndefined,
} from "../helpers.js";
import {
  opEntries,
  registerMissingOpHandlers,
  registerOpAliasHandlers,
  registerUnsupportedHandlers,
} from "../registration.js";
import {
  OUTPUT_EFFECT_ID,
  type CapabilityDefinition,
  type DefaultAdapterOutputFlush,
  type DefaultAdapterOutputTarget,
  type DefaultAdapterOutputWrite,
  type DefaultAdapterOutputWriteBytes,
  type NodeWritableWithWrite,
} from "../types.js";

const OUTPUT_WRITE_OP_NAMES = ["write", "write_op"] as const;
const OUTPUT_WRITE_BYTES_OP_NAMES = ["write_bytes", "write_bytes_op"] as const;
const OUTPUT_FLUSH_OP_NAMES = ["flush", "flush_op"] as const;
const OUTPUT_IS_TTY_OP_NAMES = ["is_tty", "is_tty_op"] as const;

type OutputSource = {
  write?: (output: DefaultAdapterOutputWrite) => Promise<void>;
  writeUnavailableReason: string;
  writeBytes?: (output: DefaultAdapterOutputWriteBytes) => Promise<void>;
  writeBytesUnavailableReason: string;
  flush?: (output: DefaultAdapterOutputFlush) => Promise<void>;
  flushUnavailableReason: string;
  isTty: (target: DefaultAdapterOutputTarget) => boolean;
};

type OutputOpMatrixEntry = {
  opNames: readonly string[];
  isSupported: boolean;
  unavailableReason: string;
  registerHandler: () => number;
};

const decodeOutputTarget = (payload: unknown): DefaultAdapterOutputTarget => {
  const target =
    toStringOrUndefined(readField(payload, "target"))?.trim().toLowerCase() ??
    "stdout";
  return target === "stderr" ? "stderr" : "stdout";
};

const decodeOutputWriteValue = (payload: unknown): string =>
  toStringOrUndefined(readField(payload, "value")) ??
  String(readField(payload, "value") ?? "");

const decodeOutputWriteBytes = (payload: unknown): Uint8Array => {
  const rawBytes = readField(payload, "bytes");
  const source = Array.isArray(rawBytes) ? rawBytes : [];
  return Uint8Array.from(source.map(normalizeByte));
};

const createOutputSource = ({
  runtime,
  runtimeHooks,
}: {
  runtime: string;
  runtimeHooks: {
    write?: (output: DefaultAdapterOutputWrite) => Promise<void>;
    writeBytes?: (output: DefaultAdapterOutputWriteBytes) => Promise<void>;
    flush?: (output: DefaultAdapterOutputFlush) => Promise<void>;
    isOutputTty?: (target: DefaultAdapterOutputTarget) => boolean;
  };
}): OutputSource => {
  let stdout: NodeWritableWithWrite | undefined;
  let stderr: NodeWritableWithWrite | undefined;
  if (runtime === "node") {
    const processValue = globalRecord.process as
      | {
          stdout?: NodeJS.WritableStream;
          stderr?: NodeJS.WritableStream;
        }
      | undefined;
    stdout = processValue?.stdout as NodeWritableWithWrite | undefined;
    stderr = processValue?.stderr as NodeWritableWithWrite | undefined;
  }

  const streamFor = (target: DefaultAdapterOutputTarget): NodeWritableWithWrite => {
    const stream = target === "stderr" ? stderr : stdout;
    if (!stream) {
      throw new Error("stdout/stderr stream is unavailable");
    }
    return stream;
  };

  const hasStreams = !!stdout && !!stderr;
  const writeFromHook = runtimeHooks.write;
  const writeBytesFromHook = runtimeHooks.writeBytes;
  const flushFromHook = runtimeHooks.flush;
  const isTtyFromHook = runtimeHooks.isOutputTty;

  const write =
    typeof writeFromHook === "function"
      ? async (output: DefaultAdapterOutputWrite) => writeFromHook(output)
      : typeof writeBytesFromHook === "function"
        ? async ({ target, value }: DefaultAdapterOutputWrite) =>
            writeBytesFromHook({
              target,
              bytes: new TextEncoder().encode(value),
            })
      : hasStreams
        ? async ({ target, value }: DefaultAdapterOutputWrite) =>
            writeToNodeStream({
              stream: streamFor(target),
              value,
            })
        : undefined;

  const writeBytes =
    typeof writeBytesFromHook === "function"
      ? async (output: DefaultAdapterOutputWriteBytes) => writeBytesFromHook(output)
      : hasStreams
        ? async ({ target, bytes }: DefaultAdapterOutputWriteBytes) =>
            writeToNodeStream({
              stream: streamFor(target),
              value: bytes,
            })
        : undefined;

  const flush =
    typeof flushFromHook === "function"
      ? async (output: DefaultAdapterOutputFlush) => flushFromHook(output)
      : hasStreams
        ? async ({ target }: DefaultAdapterOutputFlush) =>
            flushNodeStream(streamFor(target))
        : write || writeBytes
          ? async () => {}
        : undefined;

  const isTty =
    typeof isTtyFromHook === "function"
      ? isTtyFromHook
      : hasStreams
        ? (target: DefaultAdapterOutputTarget) =>
            Boolean((target === "stderr" ? stderr : stdout)?.isTTY)
        : () => false;

  const writeUnavailableReason = "text output APIs are unavailable";
  const writeBytesUnavailableReason = "byte output APIs are unavailable";
  const flushUnavailableReason = "flush APIs are unavailable";
  return {
    write,
    writeUnavailableReason: write ? "" : writeUnavailableReason,
    writeBytes,
    writeBytesUnavailableReason: writeBytes ? "" : writeBytesUnavailableReason,
    flush,
    flushUnavailableReason: flush ? "" : flushUnavailableReason,
    isTty,
  };
};

const uniqueUnavailableReasons = (matrix: OutputOpMatrixEntry[]): string => {
  const reasons = matrix
    .filter((entry) => !entry.isSupported)
    .map((entry) => entry.unavailableReason)
    .filter((reason) => reason.length > 0);
  const unique = Array.from(new Set(reasons));
  return unique.join("; ");
};

export const outputCapabilityDefinition: CapabilityDefinition = {
  capability: "output",
  effectId: OUTPUT_EFFECT_ID,
  register: async ({ host, runtime, diagnostics, runtimeHooks }) => {
    const entries = opEntries({ host, effectId: OUTPUT_EFFECT_ID });
    if (entries.length === 0) {
      return 0;
    }

    const outputSource = createOutputSource({ runtime, runtimeHooks });
    const implementedOps = new Set<string>();

    const matrix: OutputOpMatrixEntry[] = [
      {
        opNames: OUTPUT_WRITE_OP_NAMES,
        isSupported: !!outputSource.write,
        unavailableReason: outputSource.writeUnavailableReason,
        registerHandler: () =>
          registerOpAliasHandlers({
            host,
            effectId: OUTPUT_EFFECT_ID,
            opNames: OUTPUT_WRITE_OP_NAMES,
            handler: async ({ tail }, payload) => {
              try {
                await outputSource.write!({
                  target: decodeOutputTarget(payload),
                  value: decodeOutputWriteValue(payload),
                });
                return tail(hostOk());
              } catch (error) {
                return tail(hostError(outputErrorMessage(error), outputErrorCode(error)));
              }
            },
          }),
      },
      {
        opNames: OUTPUT_WRITE_BYTES_OP_NAMES,
        isSupported: !!outputSource.writeBytes,
        unavailableReason: outputSource.writeBytesUnavailableReason,
        registerHandler: () =>
          registerOpAliasHandlers({
            host,
            effectId: OUTPUT_EFFECT_ID,
            opNames: OUTPUT_WRITE_BYTES_OP_NAMES,
            handler: async ({ tail }, payload) => {
              try {
                await outputSource.writeBytes!({
                  target: decodeOutputTarget(payload),
                  bytes: decodeOutputWriteBytes(payload),
                });
                return tail(hostOk());
              } catch (error) {
                return tail(hostError(outputErrorMessage(error), outputErrorCode(error)));
              }
            },
          }),
      },
      {
        opNames: OUTPUT_FLUSH_OP_NAMES,
        isSupported: !!outputSource.flush,
        unavailableReason: outputSource.flushUnavailableReason,
        registerHandler: () =>
          registerOpAliasHandlers({
            host,
            effectId: OUTPUT_EFFECT_ID,
            opNames: OUTPUT_FLUSH_OP_NAMES,
            handler: async ({ tail }, payload) => {
              try {
                await outputSource.flush!({
                  target: decodeOutputTarget(payload),
                });
                return tail(hostOk());
              } catch (error) {
                return tail(hostError(outputErrorMessage(error), outputErrorCode(error)));
              }
            },
          }),
      },
      {
        opNames: OUTPUT_IS_TTY_OP_NAMES,
        isSupported: true,
        unavailableReason: "",
        registerHandler: () =>
          registerOpAliasHandlers({
            host,
            effectId: OUTPUT_EFFECT_ID,
            opNames: OUTPUT_IS_TTY_OP_NAMES,
            handler: ({ tail }, payload) =>
              tail(outputSource.isTty(decodeOutputTarget(payload))),
          }),
      },
    ];

    if (!matrix.some((entry) => entry.isSupported)) {
      return registerUnsupportedHandlers({
        host,
        effectId: OUTPUT_EFFECT_ID,
        capability: "output",
        runtime,
        reason: uniqueUnavailableReasons(matrix),
        diagnostics,
      });
    }

    let registered = 0;
    matrix.forEach((entry) => {
      if (entry.isSupported) {
        registered += entry.registerHandler();
      } else {
        registered += registerOpAliasHandlers({
          host,
          effectId: OUTPUT_EFFECT_ID,
          opNames: entry.opNames,
          handler: () => {
            const primaryOpName = entry.opNames[0] ?? "unknown";
            throw new Error(
              `Default adapter for ${OUTPUT_EFFECT_ID} does not implement op ${primaryOpName}. ${entry.unavailableReason}`
            );
          },
        });
      }
      entry.opNames.forEach((opName) => {
        implementedOps.add(opName);
      });
    });

    return (
      registered +
      registerMissingOpHandlers({
        host,
        effectId: OUTPUT_EFFECT_ID,
        implementedOps,
        diagnostics,
      })
    );
  },
};
