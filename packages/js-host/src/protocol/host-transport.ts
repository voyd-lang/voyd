import type { HostFrame } from "./host-frame.js";

export const HOST_ABI_VERSION = 2;
export const DTO_SCHEMA_ABI_VERSION = 1;

export type HostTransportIdentity = {
  id: string;
  version: number;
};

export type HostTransportMetadata = {
  hostAbi: number;
  dtoSchemaAbi: number;
  transport: HostTransportIdentity;
};

export type HostTransportAdapter = HostTransportIdentity & {
  encodedPayloadSize(value: unknown): number;
  encodeFrame(frame: HostFrame): Uint8Array;
  decodeFrame(bytes: Uint8Array): HostFrame;
};

export const resolveHostTransport = ({
  metadata,
  adapters = [],
}: {
  metadata: HostTransportMetadata | undefined;
  adapters?: readonly HostTransportAdapter[];
}): HostTransportAdapter => {
  if (!metadata) {
    throw new Error("Voyd module is missing host transport metadata");
  }
  if (metadata.hostAbi !== HOST_ABI_VERSION) {
    throw new Error(
      `Unsupported Voyd host ABI ${metadata.hostAbi}; expected ${HOST_ABI_VERSION}`,
    );
  }
  if (metadata.dtoSchemaAbi !== DTO_SCHEMA_ABI_VERSION) {
    throw new Error(
      `Unsupported Voyd DTO schema ABI ${metadata.dtoSchemaAbi}; expected ${DTO_SCHEMA_ABI_VERSION}`,
    );
  }

  const selected = adapters.find(
    (adapter) =>
      adapter.id === metadata.transport.id &&
      adapter.version === metadata.transport.version,
  );
  if (selected) {
    return selected;
  }
  throw new Error(
    `Missing Voyd host transport adapter ${metadata.transport.id}@${metadata.transport.version}`,
  );
};
