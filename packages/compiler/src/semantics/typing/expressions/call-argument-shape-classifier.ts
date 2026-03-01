export type CallArgumentShapeFailure =
  | { kind: "missing-argument"; paramIndex: number }
  | { kind: "missing-labeled-argument"; paramIndex: number; label: string }
  | {
      kind: "label-mismatch";
      paramIndex: number;
      argIndex: number;
      expectedLabel?: string;
      actualLabel?: string;
    }
  | { kind: "extra-arguments"; extra: number };

export type CallArgumentShapeFailureEntry<TParam> = {
  failure: CallArgumentShapeFailure;
  params: readonly TParam[];
};

const callArgumentShapeFailureKey = (failure: CallArgumentShapeFailure): string => {
  switch (failure.kind) {
    case "missing-argument":
      return `missing-argument:${failure.paramIndex}`;
    case "missing-labeled-argument":
      return `missing-labeled-argument:${failure.paramIndex}:${failure.label}`;
    case "label-mismatch":
      return `label-mismatch:${failure.paramIndex}:${failure.argIndex}:${failure.expectedLabel ?? ""}:${failure.actualLabel ?? ""}`;
    case "extra-arguments":
      return `extra-arguments:${failure.extra}`;
  }
};

export const classifyConsensusCallArgumentShapeFailure = <TParam>(
  entries: readonly CallArgumentShapeFailureEntry<TParam>[],
): CallArgumentShapeFailureEntry<TParam> | undefined => {
  if (entries.length === 0) {
    return undefined;
  }

  const first = entries[0]!;
  const failureKey = callArgumentShapeFailureKey(first.failure);
  return entries.every(
    (entry) => callArgumentShapeFailureKey(entry.failure) === failureKey,
  )
    ? first
    : undefined;
};
