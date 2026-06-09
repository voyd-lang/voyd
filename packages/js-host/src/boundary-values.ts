import type {
  BoundaryFieldSchema,
  BoundarySchema,
  BoundaryUnionSchema,
} from "./protocol/export-abi.js";

const I32_MIN = -2147483648;
const I32_MAX = 2147483647;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

export const encodeBoundaryArgs = ({
  exportName,
  schemas,
  args,
}: {
  exportName: string;
  schemas: readonly BoundarySchema[];
  args: readonly unknown[];
}): unknown[] => {
  if (args.length !== schemas.length) {
    throw new Error(
      `typed export ${exportName} expected ${schemas.length} args, got ${args.length}`,
    );
  }
  return schemas.map((schema, index) =>
    encodeBoundaryValue({
      exportName,
      schema,
      value: args[index],
      path: `arg${index}`,
    }),
  );
};

export const decodeBoundaryResult = ({
  exportName,
  schema,
  value,
}: {
  exportName: string;
  schema: BoundarySchema;
  value: unknown;
}): unknown =>
  decodeBoundaryValue({
    exportName,
    schema,
    value,
    path: "result",
  });

const encodeBoundaryValue = ({
  exportName,
  schema,
  value,
  path,
}: {
  exportName: string;
  schema: BoundarySchema;
  value: unknown;
  path: string;
}): unknown => {
  switch (schema.kind) {
    case "bool":
      return expectType({ exportName, path, expected: "bool", value, guard: isBool });
    case "i32":
      return expectI32({ exportName, path, value });
    case "i64":
      return expectI64({ exportName, path, value });
    case "f32":
    case "f64":
      return expectFloat({ exportName, path, value, expected: schema.kind });
    case "void":
      return null;
    case "string":
      return expectType({
        exportName,
        path,
        expected: "String",
        value,
        guard: isString,
      });
    case "array":
      if (!Array.isArray(value)) {
        throw typeError({ exportName, path, expected: "array", value });
      }
      return value.map((item, index) =>
        encodeBoundaryValue({
          exportName,
          schema: schema.element,
          value: item,
          path: `${path}[${index}]`,
        }),
      );
    case "record":
      return encodeRecord({
        exportName,
        fields: schema.fields,
        tag: schema.tag,
        value,
        path,
      });
    case "union":
      return encodeUnion({ exportName, schema, value, path });
  }
};

const decodeBoundaryValue = ({
  exportName,
  schema,
  value,
  path,
}: {
  exportName: string;
  schema: BoundarySchema;
  value: unknown;
  path: string;
}): unknown => {
  switch (schema.kind) {
    case "void":
      return undefined;
    case "array":
      if (!Array.isArray(value)) {
        throw typeError({ exportName, path, expected: "array", value });
      }
      return value.map((item, index) =>
        decodeBoundaryValue({
          exportName,
          schema: schema.element,
          value: item,
          path: `${path}[${index}]`,
        }),
      );
    case "record":
      return decodeRecord({
        exportName,
        fields: schema.fields,
        tag: schema.tag,
        value,
        path,
      });
    case "union":
      return decodeUnion({ exportName, schema, value, path });
    default:
      return encodeBoundaryValue({ exportName, schema, value, path });
  }
};

const encodeRecord = ({
  exportName,
  fields,
  tag,
  value,
  path,
}: {
  exportName: string;
  fields: readonly BoundaryFieldSchema[];
  tag?: string;
  value: unknown;
  path: string;
}): Record<string, unknown> => {
  const record = toRecord({ exportName, path, value });
  if (tag) {
    const actualTag = record.tag ?? record.$variant;
    if (actualTag !== tag) {
      throw new Error(
        `typed export ${exportName} ${path} expected variant tag ${tag}`,
      );
    }
  }
  return Object.fromEntries(
    fields.map((field) => [
      field.name,
      encodeBoundaryValue({
        exportName,
        schema: field.schema,
        value: record[field.name],
        path: `${path}.${field.name}`,
      }),
    ]),
  );
};

const decodeRecord = ({
  exportName,
  fields,
  tag,
  value,
  path,
}: {
  exportName: string;
  fields: readonly BoundaryFieldSchema[];
  tag?: string;
  value: unknown;
  path: string;
}): Record<string, unknown> => {
  const record = toRecord({ exportName, path, value });
  return {
    ...Object.fromEntries(
      fields.map((field) => [
        field.name,
        decodeBoundaryValue({
          exportName,
          schema: field.schema,
          value: record[field.name],
          path: `${path}.${field.name}`,
        }),
      ]),
    ),
    ...(tag ? { tag } : {}),
  };
};

const encodeUnion = ({
  exportName,
  schema,
  value,
  path,
}: {
  exportName: string;
  schema: BoundaryUnionSchema;
  value: unknown;
  path: string;
}): Record<string, unknown> => {
  const record = toRecord({ exportName, path, value });
  const tag = record.tag ?? record.$variant;
  if (typeof tag !== "string") {
    throw variantTagError({ exportName, path, schema });
  }
  const variant = schema.variants.find((candidate) => candidate.name === tag);
  if (!variant) {
    throw variantTagError({ exportName, path, schema });
  }
  return {
    ...encodeRecord({
      exportName,
      fields: variant.fields,
      value: record,
      path,
    }),
    $variant: tag,
  };
};

const decodeUnion = ({
  exportName,
  schema,
  value,
  path,
}: {
  exportName: string;
  schema: BoundaryUnionSchema;
  value: unknown;
  path: string;
}): Record<string, unknown> => {
  const record = toRecord({ exportName, path, value });
  const tag = record.$variant ?? record.tag;
  if (typeof tag !== "string") {
    throw variantTagError({ exportName, path, schema });
  }
  const variant = schema.variants.find((candidate) => candidate.name === tag);
  if (!variant) {
    throw variantTagError({ exportName, path, schema });
  }
  return {
    ...decodeRecord({
      exportName,
      fields: variant.fields,
      value: record,
      path,
    }),
    tag,
  };
};

const expectI32 = ({
  exportName,
  path,
  value,
}: {
  exportName: string;
  path: string;
  value: unknown;
}): number => {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    !Number.isFinite(value) ||
    value < I32_MIN ||
    value > I32_MAX
  ) {
    throw typeError({ exportName, path, expected: "i32", value });
  }
  return value;
};

const expectI64 = ({
  exportName,
  path,
  value,
}: {
  exportName: string;
  path: string;
  value: unknown;
}): bigint | number => {
  if (typeof value === "bigint") {
    if (value < I64_MIN || value > I64_MAX) {
      throw typeError({ exportName, path, expected: "i64", value });
    }
    return value;
  }
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    Number.isFinite(value)
  ) {
    return value;
  }
  throw typeError({ exportName, path, expected: "i64", value });
};

const expectFloat = ({
  exportName,
  path,
  value,
  expected,
}: {
  exportName: string;
  path: string;
  value: unknown;
  expected: "f32" | "f64";
}): number => {
  if (typeof value !== "number") {
    throw typeError({ exportName, path, expected, value });
  }
  return value;
};

const expectType = <T>({
  exportName,
  path,
  expected,
  value,
  guard,
}: {
  exportName: string;
  path: string;
  expected: string;
  value: unknown;
  guard: (value: unknown) => value is T;
}): T => {
  if (!guard(value)) {
    throw typeError({ exportName, path, expected, value });
  }
  return value;
};

const toRecord = ({
  exportName,
  path,
  value,
}: {
  exportName: string;
  path: string;
  value: unknown;
}): Record<string, unknown> => {
  if (value instanceof Map) {
    return Object.fromEntries(value.entries());
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw typeError({ exportName, path, expected: "object", value });
};

const variantTagError = ({
  exportName,
  path,
  schema,
}: {
  exportName: string;
  path: string;
  schema: BoundaryUnionSchema;
}): Error =>
  new Error(
    `typed export ${exportName} ${path} expected variant tag ${schema.variants
      .map((variant) => variant.name)
      .join(" | ")}`,
  );

const typeError = ({
  exportName,
  path,
  expected,
  value,
}: {
  exportName: string;
  path: string;
  expected: string;
  value: unknown;
}): Error =>
  new Error(
    `typed export ${exportName} ${path} expected ${expected}, got ${actualType(value)}`,
  );

const actualType = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isNaN(value)) return "NaN";
  return typeof value;
};

const isBool = (value: unknown): value is boolean => typeof value === "boolean";
const isString = (value: unknown): value is string => typeof value === "string";
