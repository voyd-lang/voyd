import { inputErrorCode, inputErrorMessage, isInputClosedError } from "../errors.js";
import {
  globalRecord,
  hostError,
  inputSuccessPayload,
  readBytesFromNodeStream,
  readField,
  toNumberOrUndefined,
  toStringOrUndefined,
} from "../helpers.js";
import { maybeNodeReadlinePromises } from "../runtime-imports.js";
import {
  opEntries,
  registerMissingOpHandlers,
  registerOpAliasHandlers,
  registerOpHandler,
} from "../registration.js";
import {
  INPUT_EFFECT_ID,
  type CapabilityDefinition,
  type NodeReadableWithRead,
  type NodeWritableWithWrite,
} from "../types.js";

const INPUT_READ_BYTES_OP_NAMES = ["read_bytes", "read_bytes_op"] as const;
const INPUT_IS_TTY_OP_NAMES = ["is_tty", "is_tty_op"] as const;

type InputSource = {
  readLine?: (prompt: string | null) => Promise<string | null>;
  readBytes?: (maxBytes: number) => Promise<Uint8Array | null>;
  isTty: () => boolean;
};

const createInputSource = async ({
  runtime,
  runtimeHooks,
}: {
  runtime: string;
  runtimeHooks: {
    readLine?: (prompt: string | null) => Promise<string | null>;
    readBytes?: (maxBytes: number) => Promise<Uint8Array | null>;
    isInputTty?: () => boolean;
  };
}): Promise<InputSource> => {
  const promptValue = globalRecord.prompt;
  const promptFn =
    typeof promptValue === "function"
      ? (promptValue as (prompt?: string) => string | null)
      : undefined;

  let readLine = runtimeHooks.readLine;
  let readBytes = runtimeHooks.readBytes;
  let stdin: NodeReadableWithRead | undefined;
  let stdout: NodeWritableWithWrite | undefined;

  if (!readLine && promptFn) {
    readLine = async (prompt) => {
      const value = promptFn(prompt ?? "");
      return typeof value === "string" ? value : null;
    };
  }

  if (runtime === "node") {
    const processValue = globalRecord.process as
      | {
          stdin?: NodeJS.ReadableStream;
          stdout?: NodeJS.WritableStream;
        }
      | undefined;
    stdin = processValue?.stdin as NodeReadableWithRead | undefined;
    stdout = processValue?.stdout as NodeWritableWithWrite | undefined;

    if (!readLine && stdin && stdout) {
      const readline = await maybeNodeReadlinePromises();
      if (typeof readline?.createInterface === "function") {
        readLine = async (prompt) => {
          const lineReader = readline.createInterface({
            input: stdin!,
            output: stdout!,
            terminal: true,
          });
          try {
            return await lineReader.question(prompt ?? "");
          } catch (error) {
            if (isInputClosedError(error)) {
              return null;
            }
            throw error;
          } finally {
            lineReader.close();
          }
        };
      }
    }

    if (!readBytes && stdin) {
      readBytes = (maxBytes) =>
        readBytesFromNodeStream({
          input: stdin!,
          maxBytes,
        });
    }
  }

  return {
    readLine,
    readBytes,
    isTty:
      typeof runtimeHooks.isInputTty === "function"
        ? runtimeHooks.isInputTty
        : () => Boolean(stdin?.isTTY),
  };
};

const decodeInputPrompt = (payload: unknown): string | null =>
  toStringOrUndefined(readField(payload, "prompt")) ?? null;

const decodeInputReadBytesMaxBytes = (payload: unknown): number => {
  const raw = readField(payload, "max_bytes") ?? readField(payload, "maxBytes");
  const parsed = toNumberOrUndefined(raw);
  if (parsed === undefined) {
    return 0;
  }
  return Math.max(0, Math.trunc(parsed));
};

export const inputCapabilityDefinition: CapabilityDefinition = {
  capability: "input",
  effectId: INPUT_EFFECT_ID,
  register: async ({
    host,
    runtime,
    diagnostics,
    runtimeHooks,
    effectBufferSize,
  }) => {
    const entries = opEntries({ host, effectId: INPUT_EFFECT_ID });
    if (entries.length === 0) {
      return 0;
    }

    const inputSource = await createInputSource({ runtime, runtimeHooks });
    const implementedOps = new Set<string>();
    let registered = 0;

    if (inputSource.readLine) {
      registered += registerOpHandler({
        host,
        effectId: INPUT_EFFECT_ID,
        opName: "read_line",
        handler: async ({ tail }, payload) => {
          try {
            const prompt = decodeInputPrompt(payload);
            const line = await inputSource.readLine!(prompt);
            return tail(
              inputSuccessPayload({
                opName: "read_line",
                value: line,
                effectBufferSize,
              })
            );
          } catch (error) {
            return tail(hostError(inputErrorMessage(error), inputErrorCode(error)));
          }
        },
      });
      implementedOps.add("read_line");
    }

    if (inputSource.readBytes) {
      registered += registerOpAliasHandlers({
        host,
        effectId: INPUT_EFFECT_ID,
        opNames: INPUT_READ_BYTES_OP_NAMES,
        handler: async ({ tail }, payload) => {
          try {
            const maxBytes = decodeInputReadBytesMaxBytes(payload);
            const bytes = await inputSource.readBytes!(maxBytes);
            const boundedBytes = bytes === null ? null : bytes.subarray(0, maxBytes);
            return tail(
              inputSuccessPayload({
                opName: "read_bytes",
                value:
                  boundedBytes === null ? null : Array.from(boundedBytes.values()),
                effectBufferSize,
              })
            );
          } catch (error) {
            return tail(hostError(inputErrorMessage(error), inputErrorCode(error)));
          }
        },
      });
      INPUT_READ_BYTES_OP_NAMES.forEach((opName) => {
        implementedOps.add(opName);
      });
    }

    registered += registerOpAliasHandlers({
      host,
      effectId: INPUT_EFFECT_ID,
      opNames: INPUT_IS_TTY_OP_NAMES,
      handler: ({ tail }) => tail(inputSource.isTty()),
    });
    INPUT_IS_TTY_OP_NAMES.forEach((opName) => {
      implementedOps.add(opName);
    });

    return (
      registered +
      registerMissingOpHandlers({
        host,
        effectId: INPUT_EFFECT_ID,
        implementedOps,
        diagnostics,
      })
    );
  },
};
