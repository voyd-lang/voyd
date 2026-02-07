import {
  createVoydHost,
  formatSignatureHash,
  normalizeSignatureHash,
  type EffectHandler,
  type HostInitOptions,
  type HostProtocolTable,
  type SignatureHash,
  type VoydHost,
} from "@voyd/js-host";
import type { RunOptions } from "./types.js";

type ParsedHandlerKey = {
  effectId: string;
  opName: string;
  signatureHash?: SignatureHash;
};

type EffectLookup = {
  effectId: string;
  opName: string;
  signatureHash?: SignatureHash;
  key?: string;
};

const INVALID_KEY_MESSAGE = (
  key: string
): string =>
  `Invalid handler key ${key}. Expected effectId::opName or effectId::opName::signatureHash`;

const tryNormalizeSignatureHash = (value: string): SignatureHash | undefined => {
  try {
    return formatSignatureHash(normalizeSignatureHash(value));
  } catch {
    return undefined;
  }
};

const parseHandlerKey = (key: string): ParsedHandlerKey => {
  const segments = key.split("::").map((segment) => segment.trim());
  if (segments.length < 2) {
    throw new Error(INVALID_KEY_MESSAGE(key));
  }

  const maybeSignatureHash =
    segments.length >= 3
      ? tryNormalizeSignatureHash(segments[segments.length - 1] ?? "")
      : undefined;
  const opNameIndex =
    maybeSignatureHash !== undefined ? segments.length - 2 : segments.length - 1;
  const opName = segments[opNameIndex] ?? "";
  const effectId = segments.slice(0, opNameIndex).join("::").trim();

  if (!effectId || !opName) {
    throw new Error(INVALID_KEY_MESSAGE(key));
  }

  return maybeSignatureHash
    ? { effectId, opName, signatureHash: maybeSignatureHash }
    : { effectId, opName };
};

const findOpsByEffectAndName = ({
  table,
  effectId,
  opName,
}: {
  table: HostProtocolTable;
  effectId: string;
  opName: string;
}): HostProtocolTable["ops"] =>
  table.ops.filter((op) => op.effectId === effectId && op.opName === opName);

const knownOpNamesForEffect = ({
  table,
  effectId,
}: {
  table: HostProtocolTable;
  effectId: string;
}): string[] =>
  Array.from(
    new Set(
      table.ops
        .filter((op) => op.effectId === effectId)
        .map((op) => op.opName)
    )
  );

const unknownOpMessage = ({
  effectId,
  opName,
  signatureHash,
  knownSignatures,
  knownOpNames,
}: {
  effectId: string;
  opName: string;
  signatureHash?: SignatureHash;
  knownSignatures: SignatureHash[];
  knownOpNames: string[];
}): string => {
  const target = signatureHash
    ? `${effectId}::${opName}::${signatureHash}`
    : `${effectId}::${opName}`;
  if (knownSignatures.length > 0) {
    return `Unknown effect op for ${target}. Known signatures: ${knownSignatures.join(", ")}`;
  }
  if (knownOpNames.length > 0) {
    return `Unknown effect op for ${target}. Known ops: ${knownOpNames.join(", ")}`;
  }
  return `Unknown effect op for ${target}`;
};

const ambiguousOpMessage = ({
  key,
  effectId,
  opName,
  knownSignatures,
}: {
  key: string;
  effectId: string;
  opName: string;
  knownSignatures: SignatureHash[];
}): string =>
  `Ambiguous handler key ${key}. ${effectId}::${opName} has multiple signatures (${knownSignatures.join(", ")}). Include signature hash.`;

export const resolveEffectOp = ({
  table,
  effectId,
  opName,
  signatureHash,
  key,
}: {
  table: HostProtocolTable;
} & EffectLookup): HostProtocolTable["ops"][number] => {
  const matchingOps = findOpsByEffectAndName({ table, effectId, opName });
  const knownSignatures = matchingOps.map((op) => op.signatureHash);
  const knownOpNames = knownOpNamesForEffect({ table, effectId });

  if (matchingOps.length === 0) {
    throw new Error(
      unknownOpMessage({
        effectId,
        opName,
        signatureHash,
        knownSignatures,
        knownOpNames,
      })
    );
  }

  if (signatureHash) {
    const normalized = formatSignatureHash(normalizeSignatureHash(signatureHash));
    const found = matchingOps.find(
      (op) => formatSignatureHash(normalizeSignatureHash(op.signatureHash)) === normalized
    );
    if (!found) {
      throw new Error(
        unknownOpMessage({
          effectId,
          opName,
          signatureHash: normalized,
          knownSignatures,
          knownOpNames,
        })
      );
    }
    return found;
  }

  if (matchingOps.length === 1) {
    return matchingOps[0]!;
  }

  throw new Error(
    ambiguousOpMessage({
      key: key ?? `${effectId}::${opName}`,
      effectId,
      opName,
      knownSignatures,
    })
  );
};

export const resolveSignatureHashForOp = ({
  table,
  effectId,
  opName,
  signatureHash,
  key,
}: {
  table: HostProtocolTable;
  effectId: string;
  opName: string;
  signatureHash?: SignatureHash;
  key?: string;
}): SignatureHash =>
  resolveEffectOp({
    table,
    effectId,
    opName,
    signatureHash,
    key,
  }).signatureHash;

export const buildHandlerKey = ({
  effectId,
  opName,
  signatureHash,
}: {
  effectId: string;
  opName: string;
  signatureHash?: SignatureHash;
}): string => {
  if (!signatureHash) {
    return `${effectId}::${opName}`;
  }
  return `${effectId}::${opName}::${formatSignatureHash(
    normalizeSignatureHash(signatureHash)
  )}`;
};

export const registerHandlers = ({
  host,
  handlers,
}: {
  host: VoydHost;
  handlers: Record<string, EffectHandler>;
}): void => {
  Object.entries(handlers).forEach(([key, handler]) => {
    const parsed = parseHandlerKey(key);
    const op = resolveEffectOp({
      table: host.table,
      effectId: parsed.effectId,
      opName: parsed.opName,
      signatureHash: parsed.signatureHash,
      key,
    });
    host.registerHandler(op.effectId, op.opId, op.signatureHash, handler);
  });
};

export const registerHandlersByLabelSuffix = ({
  host,
  handlersByLabelSuffix,
}: {
  host: VoydHost;
  handlersByLabelSuffix: Record<string, EffectHandler>;
}): void => {
  host.registerHandlersByLabelSuffix(handlersByLabelSuffix);
};

export const createHost = (options: HostInitOptions): Promise<VoydHost> =>
  createVoydHost(options);

export const runWithHandlers = async <T = unknown>({
  wasm,
  entryName,
  handlers,
  handlersByLabelSuffix,
  imports,
  bufferSize,
  args,
}: RunOptions): Promise<T> => {
  const host = await createHost({ wasm, imports, bufferSize });
  if (handlersByLabelSuffix) {
    registerHandlersByLabelSuffix({ host, handlersByLabelSuffix });
  }
  if (handlers) {
    registerHandlers({ host, handlers });
  }
  return host.run<T>(entryName, args);
};
