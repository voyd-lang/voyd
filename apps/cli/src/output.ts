const CIRCULAR_REFERENCE = "[Circular]";

const normalizeBigInt = (value: bigint): string => `${value}n`;

const normalizeArrayBufferView = (value: ArrayBufferView): number[] =>
  Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));

const normalizeObjectEntries = ({
  value,
  seen,
}: {
  value: Record<string, unknown>;
  seen: WeakSet<object>;
}): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, normalizeOutput(entry, seen)])
  );

const normalizeMapEntries = ({
  value,
  seen,
}: {
  value: Map<unknown, unknown>;
  seen: WeakSet<object>;
}): Record<string, unknown> =>
  Object.fromEntries(
    Array.from(value.entries()).map(([key, entry]) => [
      String(normalizeOutput(key, seen)),
      normalizeOutput(entry, seen),
    ])
  );

const normalizeOutput = (
  value: unknown,
  seen: WeakSet<object> = new WeakSet()
): unknown => {
  if (typeof value === "bigint") {
    return normalizeBigInt(value);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return CIRCULAR_REFERENCE;
  }
  seen.add(value);

  if (value instanceof Map) {
    return normalizeMapEntries({ value, seen });
  }

  if (value instanceof Set) {
    return Array.from(value).map((entry) => normalizeOutput(entry, seen));
  }

  if (ArrayBuffer.isView(value)) {
    return normalizeArrayBufferView(value);
  }

  if (value instanceof ArrayBuffer) {
    return normalizeArrayBufferView(new Uint8Array(value));
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeOutput(entry, seen));
  }

  return normalizeObjectEntries({
    value: value as Record<string, unknown>,
    seen,
  });
};

export const stringifyOutput = (value: unknown): string =>
  JSON.stringify(normalizeOutput(value), undefined, 2);

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

