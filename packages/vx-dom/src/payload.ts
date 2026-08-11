const taskObserverProperty = Symbol.for("voyd.taskObserver");

export function decodeVxPayload(value: unknown): unknown {
  const decoded = decodeDataValue(value);
  const observer =
    value !== null && typeof value === "object"
      ? (value as Record<PropertyKey, unknown>)[taskObserverProperty]
      : undefined;
  if (
    typeof observer === "function" &&
    decoded !== null &&
    typeof decoded === "object"
  ) {
    Object.defineProperty(decoded, taskObserverProperty, {
      configurable: true,
      enumerable: false,
      value: observer,
    });
  }
  return decoded;
}

const decodeDataValue = (value: unknown): unknown => {
  if (!isRecord(value)) return value;
  const variant =
    typeof value.$variant === "string"
      ? value.$variant
      : typeof value.tag === "string"
        ? value.tag
        : undefined;
  if (Array.isArray(value.fields) && variant === undefined) {
    return decodeDataFields(value.fields);
  }
  if (variant === undefined) return value;
  switch (variant) {
    case "DataNull":
      return null;
    case "DataBool":
    case "DataI32":
    case "DataI64":
    case "DataF32":
    case "DataF64":
    case "DataString":
    case "DataBytes":
      return value.value;
    case "DataArray":
      return Array.isArray(value.values)
        ? value.values.map(decodeDataValue)
        : [];
    case "DataObject":
      return decodeDataFields(value.fields);
    case "DataVariant":
      return {
        tag: value.name,
        ...decodeDataFields(value.fields),
      };
    default:
      return value;
  }
};

const decodeDataFields = (value: unknown): Record<string, unknown> => {
  if (!Array.isArray(value)) return {};
  return Object.fromEntries(
    value.flatMap((field) =>
      isRecord(field) && typeof field.name === "string"
        ? [[field.name, decodeDataValue(field.value)] as const]
        : [],
    ),
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";
