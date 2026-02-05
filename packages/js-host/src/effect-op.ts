import {
  formatSignatureHash,
  normalizeSignatureHash,
  type ParsedEffectOp,
  type ParsedEffectTable,
  type ResumeKindCode,
} from "./protocol/table.js";
import type { SignatureHash } from "./protocol/types.js";
import { RESUME_KIND } from "./runtime/constants.js";

export type EffectOpKey = string;

export type EffectOpKeyInput = {
  effectId: string;
  opId: number;
  signatureHash: SignatureHash | number;
};

export type EffectOpRequest = {
  effectId: bigint;
  opId: number;
  opIndex: number;
  resumeKind: number;
  handle: number;
  args?: unknown[];
};

const normalizeSignatureHashInput = (value: SignatureHash | number): number => {
  if (typeof value !== "number") {
    return normalizeSignatureHash(value);
  }
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`signature hash out of range: ${value}`);
  }
  return value >>> 0;
};

const resolveRequestedOpIndex = ({
  handle,
  fallbackOpIndex,
  opCount,
}: {
  handle: number;
  fallbackOpIndex: number;
  opCount: number;
}): number =>
  Number.isInteger(handle) && handle >= 0 && handle < opCount
    ? handle
    : fallbackOpIndex;

export const parseResumeKind = (value: number): ResumeKindCode => {
  if (value === RESUME_KIND.resume) return RESUME_KIND.resume;
  if (value === RESUME_KIND.tail) return RESUME_KIND.tail;
  throw new Error(`unsupported resume kind ${value}`);
};

export const resumeKindName = (value: ResumeKindCode): "tail" | "resume" =>
  value === RESUME_KIND.tail ? "tail" : "resume";

export const buildEffectOpKey = ({
  effectId,
  opId,
  signatureHash,
}: EffectOpKeyInput): EffectOpKey =>
  `${effectId}::${opId}::${formatSignatureHash(
    normalizeSignatureHashInput(signatureHash)
  )}`;

export const buildParsedEffectOpMap = ({
  ops,
}: {
  ops: ParsedEffectTable["ops"];
}): Map<EffectOpKey, ParsedEffectOp> =>
  new Map(
    ops.map((op) => [
      buildEffectOpKey({
        effectId: op.effectId,
        opId: op.opId,
        signatureHash: op.signatureHash,
      }),
      op,
    ])
  );

export const resolveParsedEffectOp = ({
  table,
  request,
}: {
  table: ParsedEffectTable;
  request: EffectOpRequest;
}): ParsedEffectOp => {
  const resumeKind = parseResumeKind(request.resumeKind);
  const opIndex = resolveRequestedOpIndex({
    handle: request.handle,
    fallbackOpIndex: request.opIndex,
    opCount: table.ops.length,
  });
  const opEntry = table.ops[opIndex];
  if (!opEntry) {
    throw new Error(`Unknown effect op index ${request.opIndex}`);
  }

  const decodedEffectId =
    typeof request.effectId === "bigint"
      ? BigInt.asUintN(64, request.effectId)
      : undefined;
  if (
    typeof decodedEffectId === "bigint" &&
    decodedEffectId !== opEntry.effectIdHash.value
  ) {
    throw new Error(
      `Effect id mismatch for opIndex ${opEntry.opIndex} (expected ${opEntry.effectIdHash.hex})`
    );
  }
  if (request.opIndex !== opEntry.opIndex) {
    throw new Error(
      `Effect op index mismatch for handle ${request.handle} (expected ${opEntry.opIndex}, got ${request.opIndex})`
    );
  }
  if (request.opId !== opEntry.opId) {
    throw new Error(
      `Effect op id mismatch for ${opEntry.label} (expected ${opEntry.opId}, got ${request.opId})`
    );
  }
  if (resumeKind !== opEntry.resumeKind) {
    throw new Error(
      `Resume kind mismatch for ${opEntry.label} (expected ${opEntry.resumeKind}, got ${resumeKind})`
    );
  }

  return opEntry;
};
