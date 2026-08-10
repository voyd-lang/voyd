import { msgPackHostTransport } from "../transports/msgpack.js";

export const HOST_ABI_VERSION = 1;
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
  encode(value: unknown): Uint8Array;
  decode(bytes: Uint8Array): unknown;
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

  const available = [msgPackHostTransport, ...adapters];
  const selected = available.find(
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
