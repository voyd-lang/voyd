import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { deserialize, serialize } from "node:v8";
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants,
} from "node:zlib";
import {
  PRECOMPILED_STD_COMPILER_ABI_ID,
  PRECOMPILED_STD_OPTIONS_ID,
  PRECOMPILED_STD_SNAPSHOT_SCHEMA,
  PRECOMPILED_STD_SNAPSHOT_VERSION,
  PRECOMPILED_STD_TRANSPORT_ID,
  restorePrecompiledStdSnapshot,
  type EncodedPrecompiledStdSnapshot,
  type PrecompiledStdSnapshotHeader,
  type PrecompiledStdSnapshotEnvelope,
  type PrecompiledStdSourceManifestEntry,
  type RestoredPrecompiledStdSnapshot,
} from "@voyd-lang/compiler/modules/precompiled-std-snapshot.js";
import {
  CALLABLE_BORROW_SUMMARY_SCHEMA,
  CALLABLE_BORROW_SUMMARY_VERSION,
} from "@voyd-lang/compiler/semantics/borrowing/callable-summary.js";
import { incrementCompilerPerfCounter } from "@voyd-lang/compiler/perf.js";

export const PRECOMPILED_STD_SNAPSHOT_FILE = "precompiled/std-semantics-v1.bin";
const ARTIFACT_MAGIC = Buffer.from("VOYDSTD2");
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_HEADER_BYTES = 1024 * 1024;
const MAX_SERIALIZED_PAYLOAD_BYTES = 128 * 1024 * 1024;
const WIRE_GRAPH_FORMAT = "voyd-reference-graph-v1";

type WireValue =
  | null
  | boolean
  | number
  | string
  | { r: number }
  | { u: 1 }
  | { n: "nan" | "positive-infinity" | "negative-infinity" | "negative-zero" };

type WireNode =
  | ["a", WireValue[]]
  | ["m", [WireValue, WireValue][]]
  | ["s", WireValue[]]
  | ["b", string]
  | ["o", [string, WireValue][]];

type WireGraph = {
  format: typeof WIRE_GRAPH_FORMAT;
  root: WireValue;
  nodes: WireNode[];
};

export type PrecompiledStdLoadStats = {
  attempts: number;
  hits: number;
  fallbacks: number;
  fallbackReasons: Readonly<Record<string, number>>;
  lastArtifactBytes?: number;
  lastLoadMs?: number;
};

const mutableStats = {
  attempts: 0,
  hits: 0,
  fallbacks: 0,
  fallbackReasons: new Map<string, number>(),
  lastArtifactBytes: undefined as number | undefined,
  lastLoadMs: undefined as number | undefined,
};
const artifactByPath = new Map<
  string,
  {
    envelope: PrecompiledStdSnapshotEnvelope;
    fastSerializedPayload?: Uint8Array;
    wireGraph?: unknown;
    canonicalCompressedPayload: Uint8Array;
    artifactBytes: number;
  }
>();

export const snapshotPrecompiledStdLoadStats = (): PrecompiledStdLoadStats => ({
  attempts: mutableStats.attempts,
  hits: mutableStats.hits,
  fallbacks: mutableStats.fallbacks,
  fallbackReasons: Object.fromEntries(mutableStats.fallbackReasons),
  lastArtifactBytes: mutableStats.lastArtifactBytes,
  lastLoadMs: mutableStats.lastLoadMs,
});

export const resetPrecompiledStdLoadStatsForTesting = (): void => {
  mutableStats.attempts = 0;
  mutableStats.hits = 0;
  mutableStats.fallbacks = 0;
  mutableStats.fallbackReasons.clear();
  mutableStats.lastArtifactBytes = undefined;
  mutableStats.lastLoadMs = undefined;
  artifactByPath.clear();
};

export const loadPrecompiledStdSnapshot = async ({
  stdRoot,
  includeTests,
}: {
  stdRoot: string;
  includeTests?: boolean;
}): Promise<RestoredPrecompiledStdSnapshot | undefined> => {
  mutableStats.attempts += 1;
  incrementCompilerPerfCounter("compiler.precompiled_std_snapshot.attempt");
  const startedAt = performance.now();
  const finish = <T>(value: T): T => {
    mutableStats.lastLoadMs = performance.now() - startedAt;
    return value;
  };
  if (includeTests === true) {
    return finish(fallback("tests-enabled"));
  }
  if (process.env.VOYD_DISABLE_PRECOMPILED_STD_SNAPSHOT === "1") {
    return finish(fallback("disabled"));
  }

  const normalizedStdRoot = path.resolve(stdRoot);
  const artifactPath = path.resolve(
    normalizedStdRoot,
    "..",
    PRECOMPILED_STD_SNAPSHOT_FILE,
  );
  try {
    const artifact =
      artifactByPath.get(artifactPath) ??
      parsePrecompiledStdArtifact(await readFile(artifactPath));
    const envelope = artifact.envelope;
    validatePrecompiledStdSnapshotHeader(envelope);
    await validateSourceManifest({
      stdRoot: normalizedStdRoot,
      header: envelope.header,
    });
    const restored = restoreArtifactPayload({
      artifact,
      stdRoot: normalizedStdRoot,
    });
    artifactByPath.set(artifactPath, {
      envelope: artifact.envelope,
      fastSerializedPayload: artifact.fastSerializedPayload,
      wireGraph: artifact.wireGraph,
      canonicalCompressedPayload: artifact.canonicalCompressedPayload,
      artifactBytes: artifact.artifactBytes,
    });
    mutableStats.hits += 1;
    mutableStats.lastArtifactBytes = artifact.artifactBytes;
    incrementCompilerPerfCounter("compiler.precompiled_std_snapshot.load_hit");
    incrementCompilerPerfCounter(
      "compiler.precompiled_std_snapshot.artifact_bytes",
      artifact.artifactBytes,
    );
    return finish(restored);
  } catch (error) {
    return finish(fallback(fallbackReason(error)));
  }
};

export const serializePrecompiledStdArtifact = ({
  header,
  payload,
}: {
  header: PrecompiledStdSnapshotHeader;
  payload: EncodedPrecompiledStdSnapshot;
}): Uint8Array => {
  const canonicalPayload = Buffer.from(
    JSON.stringify(encodeReferenceGraph(payload)),
  );
  const fastPayload = serialize(payload);
  const envelope: PrecompiledStdSnapshotEnvelope = {
    header,
    payloadSha256: sha256(canonicalPayload),
    fastPayloadSha256: sha256(fastPayload),
    fastPayloadProducer: {
      node: process.versions.node,
      v8: process.versions.v8,
    },
  };
  const serializedHeader = Buffer.from(JSON.stringify(envelope));
  const compressedFastPayload = brotliCompressSync(fastPayload, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 6,
    },
  });
  const compressedCanonicalPayload = brotliCompressSync(canonicalPayload, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 6,
    },
  });
  const headerLength = Buffer.allocUnsafe(4);
  headerLength.writeUInt32BE(serializedHeader.byteLength);
  const fastPayloadLength = Buffer.allocUnsafe(4);
  fastPayloadLength.writeUInt32BE(compressedFastPayload.byteLength);
  return Buffer.concat([
    ARTIFACT_MAGIC,
    headerLength,
    serializedHeader,
    fastPayloadLength,
    compressedFastPayload,
    compressedCanonicalPayload,
  ]);
};

export const parsePrecompiledStdArtifact = (
  raw: Uint8Array,
  { verifyCanonicalPayload = false }: { verifyCanonicalPayload?: boolean } = {},
): {
  envelope: PrecompiledStdSnapshotEnvelope;
  fastSerializedPayload?: Uint8Array;
  wireGraph?: unknown;
  canonicalCompressedPayload: Uint8Array;
  artifactBytes: number;
} => {
  const bytes = Buffer.from(raw);
  if (
    bytes.byteLength > MAX_ARTIFACT_BYTES ||
    bytes.byteLength < ARTIFACT_MAGIC.byteLength + 4 ||
    !bytes.subarray(0, ARTIFACT_MAGIC.byteLength).equals(ARTIFACT_MAGIC)
  ) {
    throw new SnapshotLoadError("artifact-shape");
  }
  const headerLength = bytes.readUInt32BE(ARTIFACT_MAGIC.byteLength);
  const headerStart = ARTIFACT_MAGIC.byteLength + 4;
  const fastPayloadLengthStart = headerStart + headerLength;
  if (
    headerLength <= 0 ||
    headerLength > MAX_HEADER_BYTES ||
    fastPayloadLengthStart + 4 >= bytes.byteLength
  ) {
    throw new SnapshotLoadError("artifact-shape");
  }
  const envelope = JSON.parse(
    bytes.subarray(headerStart, fastPayloadLengthStart).toString("utf8"),
  ) as PrecompiledStdSnapshotEnvelope;
  validatePrecompiledStdSnapshotHeader(envelope);

  const compressedFastPayloadLength = bytes.readUInt32BE(
    fastPayloadLengthStart,
  );
  const fastPayloadStart = fastPayloadLengthStart + 4;
  const canonicalPayloadStart = fastPayloadStart + compressedFastPayloadLength;
  if (
    compressedFastPayloadLength <= 0 ||
    canonicalPayloadStart >= bytes.byteLength
  ) {
    throw new SnapshotLoadError("artifact-shape");
  }

  let fastSerializedPayload: Uint8Array | undefined;
  try {
    const candidate = brotliDecompressSync(
      bytes.subarray(fastPayloadStart, canonicalPayloadStart),
      { maxOutputLength: MAX_SERIALIZED_PAYLOAD_BYTES },
    );
    if (sha256(candidate) !== envelope.fastPayloadSha256) {
      throw new SnapshotLoadError("fast-payload-integrity");
    }
    fastSerializedPayload = candidate;
  } catch {
    fastSerializedPayload = undefined;
  }

  const canonicalCompressedPayload = bytes.subarray(canonicalPayloadStart);
  let wireGraph: unknown;
  if (!fastSerializedPayload || verifyCanonicalPayload) {
    wireGraph = decodeCanonicalPayload({
      compressedPayload: canonicalCompressedPayload,
      expectedSha256: envelope.payloadSha256,
    });
    decodeReferenceGraph(wireGraph);
  }

  return {
    envelope,
    fastSerializedPayload,
    wireGraph,
    canonicalCompressedPayload,
    artifactBytes: bytes.byteLength,
  };
};

export const precompiledStdArtifactsHaveMatchingCanonicalContent = (
  left: {
    envelope: PrecompiledStdSnapshotEnvelope;
  },
  right: {
    envelope: PrecompiledStdSnapshotEnvelope;
  },
): boolean =>
  JSON.stringify(left.envelope.header) ===
    JSON.stringify(right.envelope.header) &&
  left.envelope.payloadSha256 === right.envelope.payloadSha256;

const restoreArtifactPayload = ({
  artifact,
  stdRoot,
}: {
  artifact: {
    envelope: PrecompiledStdSnapshotEnvelope;
    fastSerializedPayload?: Uint8Array;
    wireGraph?: unknown;
    canonicalCompressedPayload: Uint8Array;
  };
  stdRoot: string;
}): RestoredPrecompiledStdSnapshot => {
  if (artifact.fastSerializedPayload) {
    try {
      return restorePrecompiledStdSnapshot({
        encoded: deserialize(
          artifact.fastSerializedPayload,
        ) as EncodedPrecompiledStdSnapshot,
        stdRoot,
      });
    } catch {
      // The canonical graph is authoritative across Node/V8 versions.
    }
  }

  const wireGraph =
    artifact.wireGraph ??
    decodeCanonicalPayload({
      compressedPayload: artifact.canonicalCompressedPayload,
      expectedSha256: artifact.envelope.payloadSha256,
    });
  return restorePrecompiledStdSnapshot({
    encoded: decodeReferenceGraph(wireGraph),
    stdRoot,
  });
};

const decodeCanonicalPayload = ({
  compressedPayload,
  expectedSha256,
}: {
  compressedPayload: Uint8Array;
  expectedSha256: string;
}): unknown => {
  const serializedPayload = brotliDecompressSync(compressedPayload, {
    maxOutputLength: MAX_SERIALIZED_PAYLOAD_BYTES,
  });
  if (sha256(serializedPayload) !== expectedSha256) {
    throw new SnapshotLoadError("payload-integrity");
  }
  return JSON.parse(serializedPayload.toString("utf8")) as unknown;
};

export const createStdSourceManifest = async ({
  stdRoot,
  relativePaths,
}: {
  stdRoot: string;
  relativePaths: readonly string[];
}): Promise<{
  sources: readonly PrecompiledStdSourceManifestEntry[];
  stdContentSha256: string;
}> => {
  const normalizedPaths = [...new Set(relativePaths)]
    .map(normalizeManifestPath)
    .sort((left, right) => left.localeCompare(right));
  const sources = await Promise.all(
    normalizedPaths.map(async (relativePath) => {
      const bytes = await readFile(path.join(stdRoot, relativePath));
      return {
        path: relativePath,
        sha256: sha256(bytes),
        bytes: bytes.byteLength,
      };
    }),
  );
  return {
    sources,
    stdContentSha256: sourceManifestHash(sources),
  };
};

export const collectStdSourcePaths = async (
  stdRoot: string,
  directory = stdRoot,
): Promise<readonly string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return collectStdSourcePaths(stdRoot, absolute);
      }
      return entry.isFile() &&
        entry.name.endsWith(".voyd") &&
        !entry.name.endsWith(".test.voyd")
        ? [path.relative(stdRoot, absolute)]
        : [];
    }),
  );
  return nested.flat().sort((left, right) => left.localeCompare(right));
};

const encodeReferenceGraph = (
  payload: EncodedPrecompiledStdSnapshot,
): WireGraph => {
  const nodes: WireNode[] = [];
  const ids = new Map<object, number>();
  const encode = (value: unknown): WireValue => {
    if (value === undefined) {
      return { u: 1 };
    }
    if (value === null || typeof value === "string") {
      return value;
    }
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      if (Number.isNaN(value)) return { n: "nan" };
      if (value === Number.POSITIVE_INFINITY) return { n: "positive-infinity" };
      if (value === Number.NEGATIVE_INFINITY) return { n: "negative-infinity" };
      return Object.is(value, -0) ? { n: "negative-zero" } : value;
    }
    if (typeof value !== "object") {
      throw new SnapshotLoadError("payload-shape");
    }

    const existing = ids.get(value);
    if (existing !== undefined) {
      return { r: existing };
    }
    const id = nodes.length;
    ids.set(value, id);
    nodes.push(["o", []]);

    if (Array.isArray(value)) {
      nodes[id] = ["a", value.map(encode)];
      return { r: id };
    }
    if (value instanceof Map) {
      nodes[id] = [
        "m",
        Array.from(value, ([key, entry]): [WireValue, WireValue] => [
          encode(key),
          encode(entry),
        ]),
      ];
      return { r: id };
    }
    if (value instanceof Set) {
      nodes[id] = ["s", Array.from(value, encode)];
      return { r: id };
    }
    if (value instanceof Uint8Array) {
      nodes[id] = ["b", Buffer.from(value).toString("base64")];
      return { r: id };
    }

    nodes[id] = [
      "o",
      Object.keys(value)
        .sort()
        .map((key): [string, WireValue] => [
          key,
          encode((value as Record<string, unknown>)[key]),
        ]),
    ];
    return { r: id };
  };

  return {
    format: WIRE_GRAPH_FORMAT,
    root: encode(payload),
    nodes,
  };
};

const decodeReferenceGraph = (
  encoded: unknown,
): EncodedPrecompiledStdSnapshot => {
  if (
    !encoded ||
    typeof encoded !== "object" ||
    (encoded as { format?: unknown }).format !== WIRE_GRAPH_FORMAT ||
    !Array.isArray((encoded as { nodes?: unknown }).nodes)
  ) {
    throw new SnapshotLoadError("payload-shape");
  }
  const graph = encoded as WireGraph;
  const shells = graph.nodes.map((node): unknown => {
    if (!Array.isArray(node) || node.length !== 2) {
      throw new SnapshotLoadError("payload-shape");
    }
    switch (node[0]) {
      case "a":
        return [];
      case "m":
        return new Map<unknown, unknown>();
      case "s":
        return new Set<unknown>();
      case "b":
        return decodeBase64(node[1]);
      case "o":
        return {};
      default:
        throw new SnapshotLoadError("payload-shape");
    }
  });
  const decode = (value: WireValue): unknown => {
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "string" ||
      typeof value === "number"
    ) {
      return value;
    }
    if (!value || typeof value !== "object") {
      throw new SnapshotLoadError("payload-shape");
    }
    if ("r" in value) {
      if (
        !Number.isSafeInteger(value.r) ||
        value.r < 0 ||
        value.r >= shells.length
      ) {
        throw new SnapshotLoadError("payload-shape");
      }
      return shells[value.r];
    }
    if ("u" in value && value.u === 1) {
      return undefined;
    }
    if ("n" in value) {
      switch (value.n) {
        case "nan":
          return Number.NaN;
        case "positive-infinity":
          return Number.POSITIVE_INFINITY;
        case "negative-infinity":
          return Number.NEGATIVE_INFINITY;
        case "negative-zero":
          return -0;
      }
    }
    throw new SnapshotLoadError("payload-shape");
  };

  graph.nodes.forEach((node, index) => {
    const shell = shells[index];
    switch (node[0]) {
      case "a":
        if (!Array.isArray(node[1]) || !Array.isArray(shell)) {
          throw new SnapshotLoadError("payload-shape");
        }
        node[1].forEach((entry) => shell.push(decode(entry)));
        return;
      case "m":
        if (!Array.isArray(node[1]) || !(shell instanceof Map)) {
          throw new SnapshotLoadError("payload-shape");
        }
        node[1].forEach((entry) => {
          if (!Array.isArray(entry) || entry.length !== 2) {
            throw new SnapshotLoadError("payload-shape");
          }
          shell.set(decode(entry[0]), decode(entry[1]));
        });
        return;
      case "s":
        if (!Array.isArray(node[1]) || !(shell instanceof Set)) {
          throw new SnapshotLoadError("payload-shape");
        }
        node[1].forEach((entry) => shell.add(decode(entry)));
        return;
      case "b":
        return;
      case "o":
        if (!Array.isArray(node[1]) || !shell || typeof shell !== "object") {
          throw new SnapshotLoadError("payload-shape");
        }
        node[1].forEach((entry) => {
          if (
            !Array.isArray(entry) ||
            entry.length !== 2 ||
            typeof entry[0] !== "string"
          ) {
            throw new SnapshotLoadError("payload-shape");
          }
          Object.defineProperty(shell, entry[0], {
            configurable: true,
            enumerable: true,
            value: decode(entry[1]),
            writable: true,
          });
        });
    }
  });

  return decode(graph.root);
};

const decodeBase64 = (value: unknown): Uint8Array => {
  if (typeof value !== "string") {
    throw new SnapshotLoadError("payload-shape");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new SnapshotLoadError("payload-shape");
  }
  return Uint8Array.from(bytes);
};

export const validatePrecompiledStdSnapshotHeader = (
  envelope: PrecompiledStdSnapshotEnvelope,
): void => {
  const header = envelope.header;
  if (!header || header.schema !== PRECOMPILED_STD_SNAPSHOT_SCHEMA) {
    throw new SnapshotLoadError("schema");
  }
  if (header.version !== PRECOMPILED_STD_SNAPSHOT_VERSION) {
    throw new SnapshotLoadError("schema-version");
  }
  if (header.compilerAbiId !== PRECOMPILED_STD_COMPILER_ABI_ID) {
    throw new SnapshotLoadError("compiler-abi");
  }
  if (header.transportId !== PRECOMPILED_STD_TRANSPORT_ID) {
    throw new SnapshotLoadError("transport");
  }
  if (
    header.callableSummarySchema !== CALLABLE_BORROW_SUMMARY_SCHEMA ||
    header.callableSummaryVersion !== CALLABLE_BORROW_SUMMARY_VERSION
  ) {
    throw new SnapshotLoadError("callable-summary-schema");
  }
  if (header.optionsId !== PRECOMPILED_STD_OPTIONS_ID) {
    throw new SnapshotLoadError("options");
  }
  if (
    !Array.isArray(header.sources) ||
    header.sources.length === 0 ||
    typeof header.stdContentSha256 !== "string" ||
    typeof envelope.payloadSha256 !== "string" ||
    typeof envelope.fastPayloadSha256 !== "string" ||
    !envelope.fastPayloadProducer ||
    typeof envelope.fastPayloadProducer.node !== "string" ||
    typeof envelope.fastPayloadProducer.v8 !== "string"
  ) {
    throw new SnapshotLoadError("artifact-shape");
  }
};

const validateSourceManifest = async ({
  stdRoot,
  header,
}: {
  stdRoot: string;
  header: PrecompiledStdSnapshotEnvelope["header"];
}): Promise<void> => {
  const currentPaths = await collectStdSourcePaths(stdRoot);
  const expectedPaths = header.sources.map((entry) => entry.path);
  if (
    currentPaths.length !== expectedPaths.length ||
    currentPaths.some((entry, index) => entry !== expectedPaths[index])
  ) {
    throw new SnapshotLoadError("std-content");
  }
  const current = await createStdSourceManifest({
    stdRoot,
    relativePaths: currentPaths,
  });
  if (current.stdContentSha256 !== header.stdContentSha256) {
    throw new SnapshotLoadError("std-content");
  }
  if (
    current.sources.some((entry, index) => {
      const expected = header.sources[index];
      return (
        !expected ||
        entry.path !== expected.path ||
        entry.sha256 !== expected.sha256 ||
        entry.bytes !== expected.bytes
      );
    })
  ) {
    throw new SnapshotLoadError("std-content");
  }
};

const normalizeManifestPath = (relativePath: string): string => {
  const normalized = relativePath.replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.split("/").includes("..")
  ) {
    throw new SnapshotLoadError("source-manifest");
  }
  return normalized;
};

const sourceManifestHash = (
  sources: readonly PrecompiledStdSourceManifestEntry[],
): string => {
  const hash = createHash("sha256");
  sources.forEach((entry) => {
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entry.sha256);
    hash.update("\0");
    hash.update(String(entry.bytes));
    hash.update("\n");
  });
  return hash.digest("hex");
};

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const fallback = (
  reason: string,
): RestoredPrecompiledStdSnapshot | undefined => {
  mutableStats.fallbacks += 1;
  mutableStats.fallbackReasons.set(
    reason,
    (mutableStats.fallbackReasons.get(reason) ?? 0) + 1,
  );
  incrementCompilerPerfCounter(
    `compiler.precompiled_std_snapshot.fallback.${reason}`,
  );
  return undefined;
};

const fallbackReason = (error: unknown): string => {
  if (error instanceof SnapshotLoadError) {
    return error.reason;
  }
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  ) {
    return "missing";
  }
  if (error instanceof SyntaxError) {
    return "corrupt-json";
  }
  return "invalid-artifact";
};

class SnapshotLoadError extends Error {
  constructor(readonly reason: string) {
    super(`precompiled std snapshot rejected: ${reason}`);
  }
}
