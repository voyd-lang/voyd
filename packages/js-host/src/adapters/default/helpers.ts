import { encode } from "@msgpack/msgpack";
import { MIN_EFFECT_BUFFER_SIZE } from "../../runtime/constants.js";
import type {
  DefaultAdapterFetchResponse,
  NodeReadableWithRead,
} from "./types.js";

export const WEB_CRYPTO_MAX_BYTES_PER_CALL = 65_536;
export const MAX_TIMER_DELAY_MILLIS = 2_147_483_647;
const MAX_TIMER_DELAY_MILLIS_BIGINT = 2_147_483_647n;
export const RANDOM_FILL_MAX_REQUEST_BYTES = 1_000_000;

const MSGPACK_FIXARRAY_HEADER_BYTES = 1;
const MSGPACK_ARRAY16_HEADER_BYTES = 3;
const MSGPACK_ARRAY32_HEADER_BYTES = 5;
const MSGPACK_FIXARRAY_MAX_LENGTH = 15;
const MSGPACK_ARRAY16_MAX_LENGTH = 65_535;
const MSGPACK_MAX_BYTES_PER_BYTE_VALUE = 2;
const MSGPACK_OPTS = { useBigInt64: true } as const;

export const globalRecord = globalThis as Record<string, unknown>;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const readField = (value: unknown, key: string): unknown => {
  if (value instanceof Map) {
    return value.get(key);
  }
  if (!isRecord(value)) {
    return undefined;
  }
  return value[key];
};

export const toStringOrUndefined = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }
  return undefined;
};

export const toNumberOrUndefined = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return undefined;
};

export const toI64 = (value: unknown): bigint => {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  throw new Error(`expected i64-compatible value, got ${typeof value}`);
};

export const toNonNegativeI64 = (value: unknown): bigint => {
  const normalized = toI64(value);
  return normalized > 0n ? normalized : 0n;
};

export const normalizeByte = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return ((Math.trunc(value) % 256) + 256) % 256;
  }
  if (typeof value === "bigint") {
    return Number(((value % 256n) + 256n) % 256n);
  }
  return 0;
};

export const toNodeReadBytesChunk = (value: unknown): Uint8Array => {
  if (typeof value === "string") {
    throw new Error(
      "stdin is configured for text decoding; read_bytes requires raw byte chunks"
    );
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  throw new Error(
    `stdin.read returned unsupported chunk type (${typeof value}) for read_bytes`
  );
};

export const toPath = (value: unknown): string => {
  const path = toStringOrUndefined(value);
  if (!path) {
    throw new Error("expected path payload to be a string");
  }
  return path;
};

export const hostOk = (value?: unknown): Record<string, unknown> =>
  value === undefined ? { ok: true } : { ok: true, value };

export const hostError = (
  message: string,
  code = 1
): Record<string, unknown> => ({
  ok: false,
  code,
  message,
});

export const normalizeEffectBufferSize = (
  value: number | undefined
): number => {
  if (value === undefined || !Number.isFinite(value)) {
    return MIN_EFFECT_BUFFER_SIZE;
  }
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : MIN_EFFECT_BUFFER_SIZE;
};

export const sleepInChunks = async ({
  totalMillis,
  sleep,
}: {
  totalMillis: bigint;
  sleep: (milliseconds: number) => Promise<void>;
}): Promise<void> => {
  if (totalMillis === 0n) {
    await sleep(0);
    return;
  }

  let remaining = totalMillis;
  while (remaining > 0n) {
    const chunkMillis =
      remaining > MAX_TIMER_DELAY_MILLIS_BIGINT
        ? MAX_TIMER_DELAY_MILLIS
        : Number(remaining);
    await sleep(chunkMillis);
    remaining -= BigInt(chunkMillis);
  }
};

const payloadFitsEffectTransport = ({
  payload,
  effectBufferSize,
}: {
  payload: Record<string, unknown>;
  effectBufferSize: number;
}): boolean => {
  try {
    const encoded = encode(payload, MSGPACK_OPTS) as Uint8Array;
    return encoded.byteLength <= effectBufferSize;
  } catch {
    return false;
  }
};

export const fsTransportOverflowError = ({
  opName,
  effectBufferSize,
}: {
  opName: string;
  effectBufferSize: number;
}): Record<string, unknown> =>
  hostError(
    `Default fs adapter ${opName} response exceeds effect transport buffer (${effectBufferSize} bytes). Increase createVoydHost({ bufferSize }) or read a smaller payload.`
  );

export const fsSuccessPayload = ({
  opName,
  value,
  effectBufferSize,
}: {
  opName: string;
  value: unknown;
  effectBufferSize: number;
}): Record<string, unknown> => {
  const payload = hostOk(value);
  if (payloadFitsEffectTransport({ payload, effectBufferSize })) {
    return payload;
  }
  return fsTransportOverflowError({ opName, effectBufferSize });
};

export const fetchTransportOverflowError = ({
  effectBufferSize,
}: {
  effectBufferSize: number;
}): Record<string, unknown> =>
  hostError(
    `Default fetch adapter request response exceeds effect transport buffer (${effectBufferSize} bytes). Increase createVoydHost({ bufferSize }) or request a smaller payload.`
  );

export const fetchSuccessPayload = ({
  response,
  effectBufferSize,
}: {
  response: DefaultAdapterFetchResponse;
  effectBufferSize: number;
}): Record<string, unknown> => {
  const payload = hostOk({
    status: response.status,
    status_text: response.statusText,
    headers: response.headers.map((header) => ({
      name: header.name,
      value: header.value,
    })),
    body: response.body,
  });
  if (payloadFitsEffectTransport({ payload, effectBufferSize })) {
    return payload;
  }
  return fetchTransportOverflowError({ effectBufferSize });
};

export const inputTransportOverflowError = ({
  opName,
  effectBufferSize,
}: {
  opName: string;
  effectBufferSize: number;
}): Record<string, unknown> =>
  hostError(
    `Default input adapter ${opName} response exceeds effect transport buffer (${effectBufferSize} bytes). Increase createVoydHost({ bufferSize }) or provide shorter input.`
  );

export const inputSuccessPayload = ({
  opName,
  value,
  effectBufferSize,
}: {
  opName: string;
  value: unknown;
  effectBufferSize: number;
}): Record<string, unknown> => {
  const payload = hostOk(value);
  if (payloadFitsEffectTransport({ payload, effectBufferSize })) {
    return payload;
  }
  return inputTransportOverflowError({ opName, effectBufferSize });
};

export const joinListDirChildPath = ({
  directoryPath,
  childName,
}: {
  directoryPath: string;
  childName: string;
}): string => {
  if (directoryPath === "/") {
    return `/${childName}`;
  }
  const trimmed = directoryPath.replace(/\/+$/u, "");
  if (trimmed.length === 0) {
    return `/${childName}`;
  }
  return `${trimmed}/${childName}`;
};

export const maxTransportSafeRandomFillBytes = ({
  effectBufferSize,
}: {
  effectBufferSize: number;
}): number => {
  if (effectBufferSize <= MSGPACK_FIXARRAY_HEADER_BYTES) {
    return 0;
  }

  const arrayHeaderSize = (length: number): number => {
    if (length <= MSGPACK_FIXARRAY_MAX_LENGTH) {
      return MSGPACK_FIXARRAY_HEADER_BYTES;
    }
    if (length <= MSGPACK_ARRAY16_MAX_LENGTH) {
      return MSGPACK_ARRAY16_HEADER_BYTES;
    }
    return MSGPACK_ARRAY32_HEADER_BYTES;
  };

  let low = 0;
  let high = effectBufferSize;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const encodedWorstCaseBytes =
      arrayHeaderSize(mid) + mid * MSGPACK_MAX_BYTES_PER_BYTE_VALUE;
    if (encodedWorstCaseBytes <= effectBufferSize) {
      low = mid;
      continue;
    }
    high = mid - 1;
  }
  return low;
};

export const waitForNodeReadableChunk = async ({
  input,
  maxBytes,
}: {
  input: NodeReadableWithRead;
  maxBytes: number;
}): Promise<Uint8Array | null> =>
  new Promise((resolve, reject) => {
    const ended = (): boolean => {
      const streamState = input as NodeReadableWithRead & {
        readableEnded?: boolean;
        ended?: boolean;
        readable?: boolean;
        destroyed?: boolean;
      };
      if (streamState.readableEnded === true || streamState.ended === true) {
        return true;
      }
      return streamState.destroyed === true && streamState.readable !== true;
    };
    if (ended()) {
      resolve(null);
      return;
    }
    const onReadable = (): void => {
      try {
        const chunk = input.read(maxBytes);
        if (chunk === null || chunk === undefined) {
          if (ended()) {
            cleanup();
            resolve(null);
          }
          return;
        }
        cleanup();
        resolve(toNodeReadBytesChunk(chunk).subarray(0, maxBytes));
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onEnd = (): void => {
      cleanup();
      resolve(null);
    };
    const onError = (error: unknown): void => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const cleanup = (): void => {
      input.removeListener("readable", onReadable);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
    };
    input.on("readable", onReadable);
    input.once("end", onEnd);
    input.once("error", onError);
    onReadable();
  });

export const readBytesFromNodeStream = async ({
  input,
  maxBytes,
}: {
  input: NodeReadableWithRead;
  maxBytes: number;
}): Promise<Uint8Array | null> => {
  const limit = Math.max(0, Math.trunc(maxBytes));
  if (limit === 0) {
    return new Uint8Array();
  }
  const immediate = input.read(limit);
  if (immediate !== null && immediate !== undefined) {
    return toNodeReadBytesChunk(immediate).subarray(0, limit);
  }
  return waitForNodeReadableChunk({ input, maxBytes: limit });
};
