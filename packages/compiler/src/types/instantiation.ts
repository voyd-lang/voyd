import type { TypeId } from "../semantics/ids.js";

export interface NormalizedTypeArgs {
  applied: readonly TypeId[];
  missingCount: number;
  hasUnknown: boolean;
}

export const normalizeTypeArgs = ({
  typeArgs,
  paramCount,
  unknownType,
  context,
}: {
  typeArgs: readonly TypeId[];
  paramCount: number;
  unknownType: TypeId;
  context: string;
}): NormalizedTypeArgs => {
  if (typeArgs.length > paramCount) {
    throw new Error(
      `${context} argument count mismatch: expected ${paramCount}, received ${typeArgs.length}`
    );
  }

  const applied = Array.from({ length: paramCount }, (_, index) =>
    typeof typeArgs[index] === "number" ? typeArgs[index]! : unknownType
  );
  const missingCount = paramCount - typeArgs.length;
  const hasUnknown = applied.some((arg) => arg === unknownType);

  return {
    applied,
    missingCount,
    hasUnknown,
  };
};

export const shouldCacheInstantiation = (
  args: NormalizedTypeArgs
): boolean => args.missingCount === 0 && !args.hasUnknown;
