import type {
  BoundaryFieldSchema,
  BoundarySchema,
  BoundaryUnionSchema,
} from "./protocol/export-abi.js";

const I32_MIN = -2147483648;
const I32_MAX = 2147483647;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const BOUNDARY_PACK_CYCLE_ERROR =
  "__voyd_boundary_error: cannot encode cyclic object graph or boundary object graph exceeds maximum depth";

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
  const registry = buildSchemaRegistry(schemas);
  const ancestors = new WeakSet<object>();
  return schemas.map((schema, index) =>
    encodeBoundaryValue({
      exportName,
      schema,
      value: args[index],
      path: `arg${index}`,
      registry,
      ancestors,
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
    registry: buildSchemaRegistry([schema]),
  });

export const decodeBoundaryArgs = ({
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
  const registry = buildSchemaRegistry(schemas);
  return schemas.map((schema, index) =>
    decodeBoundaryValue({
      exportName,
      schema,
      value: args[index],
      path: `arg${index}`,
      registry,
    }),
  );
};

export const encodeDirectBoundaryArgs = ({
  exportName,
  schemas,
  args,
}: {
  exportName: string;
  schemas: readonly BoundarySchema[];
  args: readonly unknown[];
}): unknown[] =>
  encodeBoundaryArgs({ exportName, schemas, args }).map((value, index) => {
    const schema = schemas[index]!;
    switch (schema.kind) {
      case "bool":
        return value ? 1 : 0;
      case "i64":
        return typeof value === "number" ? BigInt(value) : value;
      case "i32":
      case "f32":
      case "f64":
        return value;
      default:
        throw new Error(
          `typed export ${exportName} has unsupported direct parameter schema ${schema.kind}`,
        );
    }
  });

export const decodeDirectBoundaryResult = ({
  exportName,
  schema,
  value,
}: {
  exportName: string;
  schema: BoundarySchema;
  value: unknown;
}): unknown => {
  switch (schema.kind) {
    case "bool":
      return decodeBoundaryResult({
        exportName,
        schema,
        value: value !== 0,
      });
    case "i32":
    case "i64":
    case "f32":
    case "f64":
    case "void":
      return decodeBoundaryResult({ exportName, schema, value });
    default:
      throw new Error(
        `typed export ${exportName} has unsupported direct result schema ${schema.kind}`,
      );
  }
};

const encodeBoundaryValue = ({
  exportName,
  schema,
  value,
  path,
  registry,
  ancestors,
}: {
  exportName: string;
  schema: BoundarySchema;
  value: unknown;
  path: string;
  registry: ReadonlyMap<number, BoundarySchema>;
  ancestors: WeakSet<object>;
}): unknown => {
  if (schema.kind === "ref") {
    return encodeBoundaryValue({
      exportName,
      schema: resolveSchemaRef({ schema, registry, path }),
      value,
      path,
      registry,
      ancestors,
    });
  }
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
      return withCycleCheck({ exportName, path, value, ancestors }, () =>
        value.map((item, index) =>
          encodeBoundaryValue({
            exportName,
            schema: schema.element,
            value: item,
            path: `${path}[${index}]`,
            registry,
            ancestors,
          }),
        ),
      );
    case "record":
      return encodeRecord({
        exportName,
        fields: schema.fields,
        tag: schema.tag,
        value,
        path,
        registry,
        ancestors,
      });
    case "union":
      return encodeUnion({ exportName, schema, value, path, registry, ancestors });
  }
};

const decodeBoundaryValue = ({
  exportName,
  schema,
  value,
  path,
  registry,
}: {
  exportName: string;
  schema: BoundarySchema;
  value: unknown;
  path: string;
  registry: ReadonlyMap<number, BoundarySchema>;
}): unknown => {
  if (schema.kind === "ref") {
    if (value === BOUNDARY_PACK_CYCLE_ERROR) {
      throw cycleError({ exportName, path });
    }
    return decodeBoundaryValue({
      exportName,
      schema: resolveSchemaRef({ schema, registry, path }),
      value,
      path,
      registry,
    });
  }
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
          registry,
        }),
      );
    case "record":
      return decodeRecord({
        exportName,
        fields: schema.fields,
        tag: schema.tag,
        value,
        path,
        registry,
      });
    case "union":
      return decodeUnion({ exportName, schema, value, path, registry });
    default:
      return encodeBoundaryValue({
        exportName,
        schema,
        value,
        path,
        registry,
        ancestors: new WeakSet<object>(),
      });
  }
};

const encodeRecord = ({
  exportName,
  fields,
  tag,
  value,
  path,
  registry,
  ancestors,
}: {
  exportName: string;
  fields: readonly BoundaryFieldSchema[];
  tag?: string;
  value: unknown;
  path: string;
  registry: ReadonlyMap<number, BoundarySchema>;
  ancestors: WeakSet<object>;
}): Record<string, unknown> => {
  return withCycleCheck({ exportName, path, value: toCycleObject(value), ancestors }, () => {
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
      fields.flatMap((field) => {
        const fieldValue = record[field.name];
        if (field.optional && (fieldValue === undefined || fieldValue === null)) {
          return [];
        }
        return [[
          field.name,
          encodeBoundaryValue({
            exportName,
            schema: field.schema,
            value: fieldValue,
            path: `${path}.${field.name}`,
            registry,
            ancestors,
          }),
        ]];
      }),
    );
  });
};

const decodeRecord = ({
  exportName,
  fields,
  tag,
  value,
  path,
  registry,
}: {
  exportName: string;
  fields: readonly BoundaryFieldSchema[];
  tag?: string;
  value: unknown;
  path: string;
  registry: ReadonlyMap<number, BoundarySchema>;
}): Record<string, unknown> => {
  const record = toRecord({ exportName, path, value });
  return {
    ...Object.fromEntries(
      fields.flatMap((field) => {
        if (field.optional && !(field.name in record)) {
          return [];
        }
        return [[
          field.name,
          decodeBoundaryValue({
            exportName,
            schema: field.schema,
            value: record[field.name],
            path: `${path}.${field.name}`,
            registry,
          }),
        ]];
      }),
    ),
    ...(tag ? { tag } : {}),
  };
};

const encodeUnion = ({
  exportName,
  schema,
  value,
  path,
  registry,
  ancestors,
}: {
  exportName: string;
  schema: BoundaryUnionSchema;
  value: unknown;
  path: string;
  registry: ReadonlyMap<number, BoundarySchema>;
  ancestors: WeakSet<object>;
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
      registry,
      ancestors,
    }),
    $variant: tag,
  };
};

const decodeUnion = ({
  exportName,
  schema,
  value,
  path,
  registry,
}: {
  exportName: string;
  schema: BoundaryUnionSchema;
  value: unknown;
  path: string;
  registry: ReadonlyMap<number, BoundarySchema>;
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
      registry,
    }),
    tag,
  };
};

const buildSchemaRegistry = (
  schemas: readonly BoundarySchema[],
): ReadonlyMap<number, BoundarySchema> => {
  const registry = new Map<number, BoundarySchema>();
  const visit = (schema: BoundarySchema): void => {
    if (typeof schema.typeId === "number" && !registry.has(schema.typeId)) {
      registry.set(schema.typeId, schema);
    }
    if (
      schema.kind === "array" ||
      schema.kind === "record" ||
      schema.kind === "union"
    ) {
      schema.aliases?.forEach((alias) => registry.set(alias, schema));
    }
    switch (schema.kind) {
      case "array":
        visit(schema.element);
        return;
      case "record":
        schema.fields.forEach((field) => visit(field.schema));
        return;
      case "union":
        schema.variants.forEach((variant) =>
          variant.fields.forEach((field) => visit(field.schema)),
        );
        return;
      default:
        return;
    }
  };
  schemas.forEach(visit);
  return registry;
};

const resolveSchemaRef = ({
  schema,
  registry,
  path,
}: {
  schema: Extract<BoundarySchema, { kind: "ref" }>;
  registry: ReadonlyMap<number, BoundarySchema>;
  path: string;
}): BoundarySchema => {
  const resolved = registry.get(schema.typeId);
  if (!resolved || resolved.kind === "ref") {
    throw new Error(`typed export ${path} has unresolved recursive schema ref ${schema.typeId}`);
  }
  return resolved;
};

const withCycleCheck = <T>(
  {
    exportName,
    path,
    value,
    ancestors,
  }: {
    exportName: string;
    path: string;
    value: object;
    ancestors: WeakSet<object>;
  },
  run: () => T,
): T => {
  if (ancestors.has(value)) {
    throw cycleError({ exportName, path });
  }
  ancestors.add(value);
  try {
    return run();
  } finally {
    ancestors.delete(value);
  }
};

const cycleError = ({
  exportName,
  path,
}: {
  exportName: string;
  path: string;
}): Error =>
  new Error(
    `typed export ${exportName} ${formatErrorPath(path)} cannot encode cyclic object graph`,
  );

const formatErrorPath = (path: string): string => {
  const maxLength = 160;
  return path.length <= maxLength ? path : `${path.slice(0, maxLength)}...`;
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

const toCycleObject = (value: unknown): object => {
  if (value instanceof Map) return value;
  if (typeof value === "object" && value !== null) return value;
  return {};
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
