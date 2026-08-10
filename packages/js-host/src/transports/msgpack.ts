import { decode, encode } from "@msgpack/msgpack";
import type { HostTransportAdapter } from "../protocol/host-transport.js";

const OPTIONS = { useBigInt64: true } as const;

export const msgPackHostTransport: HostTransportAdapter = Object.freeze({
  id: "voyd.std.msgpack",
  version: 1,
  encode: (value) => encode(value, OPTIONS) as Uint8Array,
  decode: (bytes) => decode(bytes, OPTIONS),
});
