const CIRCULAR_REFERENCE = "[Circular]";

const normalizeBigInt = (value: bigint): string => `${value}n`;

const normalizeArrayBufferView = (value: ArrayBufferView): number[] =>
  Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));

const normalizeWithTraversalTracking = ({
  value,
  ancestors,
  normalize,
}: {
  value: object;
  ancestors: WeakSet<object>;
  normalize: () => unknown;
}): unknown => {
  if (ancestors.has(value)) {
    return CIRCULAR_REFERENCE;
  }

  ancestors.add(value);
  try {
    return normalize();
  } finally {
    ancestors.delete(value);
  }
};

const normalizeObjectEntries = ({
  value,
  ancestors,
}: {
  value: Record<string, unknown>;
  ancestors: WeakSet<object>;
}): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      normalizeOutput({ value: entry, ancestors }),
    ])
  );

const normalizeMapEntries = ({
  value,
  ancestors,
}: {
  value: Map<unknown, unknown>;
  ancestors: WeakSet<object>;
}): Record<string, unknown> =>
  Object.fromEntries(
    Array.from(value.entries()).map(([key, entry]) => [
      String(normalizeOutput({ value: key, ancestors })),
      normalizeOutput({ value: entry, ancestors }),
    ])
  );

const normalizeOutput = (
  { value, ancestors = new WeakSet() }: { value: unknown; ancestors?: WeakSet<object> }
): unknown => {
  if (typeof value === "bigint") {
    return normalizeBigInt(value);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return normalizeWithTraversalTracking({
    value,
    ancestors,
    normalize: () => {
      if (value instanceof Map) {
        return normalizeMapEntries({ value, ancestors });
      }

      if (value instanceof Set) {
        return Array.from(value).map((entry) =>
          normalizeOutput({ value: entry, ancestors })
        );
      }

      if (ArrayBuffer.isView(value)) {
        return normalizeArrayBufferView(value);
      }

      if (value instanceof ArrayBuffer) {
        return normalizeArrayBufferView(new Uint8Array(value));
      }

      if (Array.isArray(value)) {
        return value.map((entry) => normalizeOutput({ value: entry, ancestors }));
      }

      return normalizeObjectEntries({
        value: value as Record<string, unknown>,
        ancestors,
      });
    },
  });
};

export const stringifyOutput = (value: unknown): string =>
  JSON.stringify(normalizeOutput({ value }), undefined, 2);

export const printJson = (value: unknown): void => {
  console.log(stringifyOutput(value));
};

export const printValue = (value: unknown): void => {
  if (typeof value === "bigint") {
    console.log(normalizeBigInt(value));
    return;
  }

  if (value === null || typeof value !== "object") {
    console.log(value);
    return;
  }

  printJson(value);
};
