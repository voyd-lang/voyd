import {
  RANDOM_FILL_MAX_REQUEST_BYTES,
  WEB_CRYPTO_MAX_BYTES_PER_CALL,
  globalRecord,
  maxTransportSafeRandomFillBytes,
  toNumberOrUndefined,
} from "../helpers.js";
import {
  opEntries,
  registerMissingOpHandlers,
  registerOpHandler,
  registerUnsupportedHandlers,
} from "../registration.js";
import { RANDOM_EFFECT_ID, type CapabilityDefinition } from "../types.js";

type RandomSource = {
  isAvailable: boolean;
  unavailableReason: string;
  readBytes: (length: number) => Uint8Array;
};

const createRandomSource = ({
  randomBytes,
}: {
  randomBytes?: (length: number) => Uint8Array;
}): RandomSource => {
  if (typeof randomBytes === "function") {
    return {
      isAvailable: true,
      unavailableReason: "",
      readBytes: (length) => {
        const fromHook = randomBytes(length);
        if (fromHook.byteLength < length) {
          throw new Error(
            `runtime randomBytes hook returned ${fromHook.byteLength} bytes, expected at least ${length}`
          );
        }
        return fromHook.byteLength === length
          ? fromHook
          : fromHook.subarray(0, length);
      },
    };
  }

  const crypto = globalRecord.crypto as
    | { getRandomValues?: <T extends ArrayBufferView>(array: T) => T }
    | undefined;
  if (typeof crypto?.getRandomValues === "function") {
    const getRandomValues = crypto.getRandomValues.bind(crypto);
    return {
      isAvailable: true,
      unavailableReason: "",
      readBytes: (length) => {
        const bytes = new Uint8Array(length);
        for (
          let offset = 0;
          offset < length;
          offset += WEB_CRYPTO_MAX_BYTES_PER_CALL
        ) {
          const end = Math.min(offset + WEB_CRYPTO_MAX_BYTES_PER_CALL, length);
          getRandomValues(bytes.subarray(offset, end));
        }
        return bytes;
      },
    };
  }

  const unavailableReason = "crypto.getRandomValues is unavailable";
  return {
    isAvailable: false,
    unavailableReason,
    readBytes: () => {
      throw new Error(unavailableReason);
    },
  };
};

export const randomCapabilityDefinition: CapabilityDefinition = {
  capability: "random",
  effectId: RANDOM_EFFECT_ID,
  register: async ({
    host,
    runtime,
    diagnostics,
    runtimeHooks,
    effectBufferSize,
  }) => {
    const entries = opEntries({ host, effectId: RANDOM_EFFECT_ID });
    if (entries.length === 0) {
      return 0;
    }

    const randomSource = createRandomSource({
      randomBytes: runtimeHooks.randomBytes,
    });
    if (!randomSource.isAvailable) {
      return registerUnsupportedHandlers({
        host,
        effectId: RANDOM_EFFECT_ID,
        capability: "random",
        runtime,
        reason: randomSource.unavailableReason,
        diagnostics,
      });
    }

    const implementedOps = new Set<string>();
    let registered = 0;

    registered += registerOpHandler({
      host,
      effectId: RANDOM_EFFECT_ID,
      opName: "next_i64",
      handler: ({ tail }) => {
        const bytes = randomSource.readBytes(8);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return tail(view.getBigInt64(0, true));
      },
    });
    implementedOps.add("next_i64");

    registered += registerOpHandler({
      host,
      effectId: RANDOM_EFFECT_ID,
      opName: "next_u64",
      handler: ({ tail }) => {
        const bytes = randomSource.readBytes(8);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const unsigned = view.getBigUint64(0, true);
        return tail(BigInt.asIntN(64, unsigned));
      },
    });
    implementedOps.add("next_u64");

    registered += registerOpHandler({
      host,
      effectId: RANDOM_EFFECT_ID,
      opName: "fill_bytes",
      handler: ({ tail }, lenPayload) => {
        const requested = Math.max(0, toNumberOrUndefined(lenPayload) ?? 0);
        const length = Math.min(
          Math.trunc(requested),
          RANDOM_FILL_MAX_REQUEST_BYTES,
          maxTransportSafeRandomFillBytes({ effectBufferSize })
        );
        const bytes = randomSource.readBytes(length);
        return tail(Array.from(bytes.values()));
      },
    });
    implementedOps.add("fill_bytes");

    return (
      registered +
      registerMissingOpHandlers({
        host,
        effectId: RANDOM_EFFECT_ID,
        implementedOps,
        diagnostics,
      })
    );
  },
};
