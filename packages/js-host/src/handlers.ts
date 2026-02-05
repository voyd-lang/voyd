import type { EffectHandler, HostProtocolTable, SignatureHash } from "./protocol/types.js";

export type LabelHandlerMatch = {
  effectId: string;
  opId: number;
  signatureHash: SignatureHash;
  handler: EffectHandler;
};

const groupOpsByEffect = (
  ops: HostProtocolTable["ops"]
): Map<string, HostProtocolTable["ops"]> =>
  ops.reduce((acc, op) => {
    const bucket = acc.get(op.effectId) ?? [];
    bucket.push(op);
    acc.set(op.effectId, bucket);
    return acc;
  }, new Map<string, HostProtocolTable["ops"]>());

const findMatchingSuffix = (
  label: string | undefined,
  suffixes: string[]
): string | undefined => {
  return suffixes.find((suffix) => label?.endsWith(suffix));
};

export const buildHandlersByLabelSuffix = ({
  table,
  handlersByLabelSuffix,
}: {
  table: HostProtocolTable;
  handlersByLabelSuffix: Record<string, EffectHandler>;
}): LabelHandlerMatch[] => {
  const suffixes = Object.keys(handlersByLabelSuffix);
  if (suffixes.length === 0) return [];

  const opsByEffectId = groupOpsByEffect(table.ops);
  let bestScore = 0;
  const matchingGroups: HostProtocolTable["ops"][] = [];

  opsByEffectId.forEach((ops) => {
    const score = ops.reduce((count, op) => {
      return findMatchingSuffix(op.label, suffixes) ? count + 1 : count;
    }, 0);
    if (score === 0) return;
    if (score > bestScore) {
      bestScore = score;
      matchingGroups.length = 0;
      matchingGroups.push(ops);
      return;
    }
    if (score === bestScore) {
      matchingGroups.push(ops);
    }
  });

  if (matchingGroups.length === 0 || bestScore === 0) return [];

  return matchingGroups.flatMap((ops) =>
    ops.flatMap((op) => {
      const suffix = findMatchingSuffix(op.label, suffixes);
      if (!suffix) return [];
      const handler = handlersByLabelSuffix[suffix];
      if (!handler) return [];
      return [
        {
          effectId: op.effectId,
          opId: op.opId,
          signatureHash: op.signatureHash,
          handler,
        },
      ];
    })
  );
};

export type LabelHandlerHost = {
  table: HostProtocolTable;
  registerHandler: (
    effectId: string,
    opId: number,
    signatureHash: SignatureHash,
    handler: EffectHandler
  ) => void;
};

export const registerHandlersByLabelSuffix = ({
  host,
  handlersByLabelSuffix,
}: {
  host: LabelHandlerHost;
  handlersByLabelSuffix: Record<string, EffectHandler>;
}): number => {
  const matches = buildHandlersByLabelSuffix({
    table: host.table,
    handlersByLabelSuffix,
  });
  matches.forEach((entry) => {
    host.registerHandler(
      entry.effectId,
      entry.opId,
      entry.signatureHash,
      entry.handler
    );
  });
  return matches.length;
};
