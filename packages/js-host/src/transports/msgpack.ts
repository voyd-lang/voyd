import { decode, encode } from "@msgpack/msgpack";
import type { HostTransportAdapter } from "../protocol/host-transport.js";
import { fromMsgPackHostFrame, toMsgPackHostFrame } from "./msgpack-frame.js";

const OPTIONS = { useBigInt64: true } as const;

export const msgPackHostTransport: HostTransportAdapter = Object.freeze({
  id: "voyd.std.msgpack",
  version: 1,
  encodedPayloadSize: (value) =>
    (encode(value, OPTIONS) as Uint8Array).byteLength,
  decodePayload: (bytes) => decode(bytes.slice(), OPTIONS),
  encodeFrame: (frame) =>
    encode(toMsgPackHostFrame(frame), OPTIONS) as Uint8Array,
  decodeFrame: (bytes) =>
    fromMsgPackHostFrame(decode(bytes.slice(), OPTIONS)),
});
