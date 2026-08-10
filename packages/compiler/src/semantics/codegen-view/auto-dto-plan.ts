import {
  isStdIntrinsicNominalType,
  STD_INTRINSIC_TYPE,
} from "../../compiler-contracts/types.js";
import type { TypeId } from "../ids.js";
import { sha256Hex } from "../../utils/sha256.js";
import type {
  CodegenStructuralField,
  ProgramCodegenView,
} from "./index.js";

export type AutoDtoPrimitivePlan =
  | { kind: "bool"; typeId: TypeId }
  | { kind: "i32"; typeId: TypeId }
  | { kind: "i64"; typeId: TypeId }
  | { kind: "f32"; typeId: TypeId }
  | { kind: "f64"; typeId: TypeId }
  | { kind: "void"; typeId: TypeId }
  | { kind: "string"; typeId: TypeId }
  | { kind: "bytes"; typeId: TypeId };

export type AutoDtoFieldPlan = {
  name: string;
  typeId: TypeId;
  schema: AutoDtoPlan;
  optional?: boolean;
  documentation?: string;
};

export type AutoDtoPlan = (
  | AutoDtoPrimitivePlan
  | {
      kind: "array";
      typeId: TypeId;
      aliases?: readonly TypeId[];
      elementTypeId: TypeId;
      element: AutoDtoPlan;
    }
  | {
      kind: "record";
      typeId: TypeId;
      aliases?: readonly TypeId[];
      name: string;
      tag?: string;
      documentation?: string;
      fields: readonly AutoDtoFieldPlan[];
    }
  | {
      kind: "union";
      typeId: TypeId;
      aliases?: readonly TypeId[];
      name: string;
      documentation?: string;
      variants: readonly {
        name: string;
        typeId: TypeId;
        documentation?: string;
        fields: readonly AutoDtoFieldPlan[];
      }[];
    }
  | { kind: "ref"; typeId: TypeId; name: string }
) & { fingerprint?: string };

export type AutoDtoPlanIndex = {
  get(input: { typeId: TypeId; moduleId: string; label?: string }): AutoDtoPlan;
  isEligible(input: { typeId: TypeId; moduleId: string }): boolean;
};

export class AutoDtoPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutoDtoPlanError";
  }
}

const RESERVED_VARIANT_FIELD_NAMES = new Set(["tag", "$variant"]);
const DTO_SUMMARY =
  "boundary-compatible DTO values are bool, i32, i64, f32, f64, void, String, Bytes, Array<T>, public-field records, and named unions of eligible variants";

export const createAutoDtoPlanIndex = (
  getProgram: () => ProgramCodegenView,
): AutoDtoPlanIndex => {
  const cache = new Map<string, AutoDtoPlan>();
  const get = ({
    typeId,
    moduleId,
    label = "value",
  }: {
    typeId: TypeId;
    moduleId: string;
    label?: string;
  }): AutoDtoPlan => {
    const key = `${moduleId}:${typeId}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const program = getProgram();
    const derived = derive({
      typeId,
      moduleId,
      path: label,
      active: new Set<TypeId>(),
      program,
    });
    const plan = { ...derived, fingerprint: dtoPlanFingerprint(derived) };
    cache.set(key, plan);
    return plan;
  };
  return {
    get,
    isEligible: ({ typeId, moduleId }) => {
      try {
        get({ typeId, moduleId });
        return true;
      } catch (error) {
        if (error instanceof AutoDtoPlanError) return false;
        throw error;
      }
    },
  };
};

export const dtoPlanFingerprint = (plan: AutoDtoPlan): string =>
  sha256Hex(canonicalDtoPlanBytes(plan));

export const canonicalDtoPlanBytes = (plan: AutoDtoPlan): Uint8Array =>
  new TextEncoder().encode(JSON.stringify([1, canonicalNode(plan)]));

const canonicalNode = (plan: AutoDtoPlan): unknown => {
  switch (plan.kind) {
    case "bool":
    case "i32":
    case "i64":
    case "f32":
    case "f64":
    case "void":
    case "string":
    case "bytes":
      return [plan.kind];
    case "array":
      return ["array", canonicalNode(plan.element)];
    case "record":
      return [
        "record",
        plan.name,
        plan.tag ?? null,
        plan.fields.map((field) => [
          field.name,
          field.optional === true,
          canonicalNode(field.schema),
        ]),
      ];
    case "union":
      return [
        "union",
        plan.name,
        plan.variants.map((variant) => [
          variant.name,
          variant.fields.map((field) => [
            field.name,
            field.optional === true,
            canonicalNode(field.schema),
          ]),
        ]),
      ];
    case "ref":
      return ["ref", plan.name];
  }
};

const derive = ({
  typeId,
  moduleId,
  path,
  active,
  program,
}: {
  typeId: TypeId;
  moduleId: string;
  path: string;
  active: Set<TypeId>;
  program: ProgramCodegenView;
}): AutoDtoPlan => {
  if (active.has(typeId)) {
    return { kind: "ref", typeId, name: portableName(typeId, program) };
  }
  const primitive = primitivePlan(typeId, program);
  if (primitive) return primitive;
  if (isIntrinsic(typeId, STD_INTRINSIC_TYPE.string, program)) {
    return { kind: "string", typeId };
  }
  if (isIntrinsic(typeId, STD_INTRINSIC_TYPE.bytes, program)) {
    return { kind: "bytes", typeId };
  }

  active.add(typeId);
  try {
    const array = arrayInfo(typeId, program);
    if (array) {
      assertArrayStorage(array.arrayTypeId, path, program);
      return {
        kind: "array",
        typeId: array.arrayTypeId,
        elementTypeId: array.elementTypeId,
        element: derive({
          typeId: array.elementTypeId,
          moduleId,
          path: `${path}[]`,
          active,
          program,
        }),
      };
    }
    const desc = program.types.getTypeDesc(typeId);
    if (desc.kind === "recursive") {
      const unfolded = program.types.substitute(
        desc.body,
        new Map([[desc.binder, typeId]]),
      );
      return withAlias(
        derive({ typeId: unfolded, moduleId, path, active, program }),
        typeId,
      );
    }
    if (desc.kind === "union") {
      return deriveUnion({ typeId, moduleId, path, active, program });
    }
    if (desc.kind === "intersection") {
      if (typeof desc.nominal === "number") {
        return derive({
          typeId: desc.nominal,
          moduleId,
          path,
          active,
          program,
        });
      }
      if (typeof desc.structural === "number") {
        return deriveRecord({ typeId, moduleId, path, active, program });
      }
    }
    if (
      desc.kind === "nominal-object" ||
      desc.kind === "value-object" ||
      desc.kind === "structural-object"
    ) {
      return deriveRecord({ typeId, moduleId, path, active, program });
    }
    return unsupported(typeId, path, program);
  } finally {
    active.delete(typeId);
  }
};

const deriveRecord = ({
  typeId,
  moduleId,
  path,
  active,
  program,
}: {
  typeId: TypeId;
  moduleId: string;
  path: string;
  active: Set<TypeId>;
  program: ProgramCodegenView;
}): AutoDtoPlan => {
  const fields = structuralFields(typeId, program);
  if (!fields) return unsupported(typeId, path, program, "record layout is unavailable");
  const tag = program.types.getStandaloneVariantTag(typeId);
  const reserved = tag
    ? fields.find((field) => RESERVED_VARIANT_FIELD_NAMES.has(field.name))
    : undefined;
  if (reserved) {
    return unsupported(
      reserved.type,
      `${path}.${reserved.name}`,
      program,
      `variant payload fields named "${reserved.name}" conflict with the JS boundary discriminator`,
    );
  }
  const identity = portableIdentity(typeId, program);
  return {
    kind: "record",
    typeId,
    name: identity.name,
    ...(tag ? { tag } : {}),
    ...(identity.documentation ? { documentation: identity.documentation } : {}),
    fields: deriveFields({
      fields,
      moduleId,
      path,
      active,
      program,
    }),
  };
};

const deriveUnion = ({
  typeId,
  moduleId,
  path,
  active,
  program,
}: {
  typeId: TypeId;
  moduleId: string;
  path: string;
  active: Set<TypeId>;
  program: ProgramCodegenView;
}): AutoDtoPlan => {
  const desc = program.types.getTypeDesc(typeId);
  if (desc.kind !== "union") throw new Error("expected union DTO plan");
  const variants = desc.members.map((member) => {
    const fields = structuralFields(member, program);
    if (!fields) {
      return unsupported(member, path, program, "union variants must be named records");
    }
    const name = variantName(member, program);
    const reserved = fields.find((field) =>
      RESERVED_VARIANT_FIELD_NAMES.has(field.name),
    );
    if (reserved) {
      return unsupported(
        reserved.type,
        `${path}.${name}.${reserved.name}`,
        program,
        `variant payload fields named "${reserved.name}" conflict with the JS boundary discriminator`,
      );
    }
    const identity = portableIdentity(member, program);
    return {
      name,
      typeId: member,
      ...(identity.documentation ? { documentation: identity.documentation } : {}),
      fields: deriveFields({
        fields,
        moduleId,
        path: `${path}.${name}`,
        active,
        program,
      }),
    };
  });
  const duplicate = variants.find(
    (variant, index) =>
      variants.findIndex((candidate) => candidate.name === variant.name) !== index,
  );
  if (duplicate) {
    return unsupported(
      typeId,
      `${path}.${duplicate.name}`,
      program,
      `multiple union variants use the "$variant" discriminator "${duplicate.name}"`,
    );
  }
  const identity = portableIdentity(typeId, program);
  return {
    kind: "union",
    typeId,
    name: identity.name,
    ...(identity.documentation ? { documentation: identity.documentation } : {}),
    variants,
  };
};

const deriveFields = ({
  fields,
  moduleId,
  path,
  active,
  program,
}: {
  fields: readonly CodegenStructuralField[];
  moduleId: string;
  path: string;
  active: Set<TypeId>;
  program: ProgramCodegenView;
}): AutoDtoFieldPlan[] =>
  fields.map((field) => {
    if (field.visibility?.level === "object") {
      return unsupported(
        field.type,
        `${path}.${field.name}`,
        program,
        "private fields are not included in DTOs",
      );
    }
    const optional = field.optional
      ? program.optionals.getOptionalInfo(moduleId, field.type)
      : undefined;
    const fieldTypeId = optional?.innerType ?? field.type;
    return {
      name: field.name,
      typeId: fieldTypeId,
      ...(field.optional ? { optional: true } : {}),
      ...(field.documentation ? { documentation: field.documentation } : {}),
      schema: derive({
        typeId: fieldTypeId,
        moduleId,
        path: `${path}.${field.name}`,
        active,
        program,
      }),
    };
  });

const structuralFields = (
  typeId: TypeId,
  program: ProgramCodegenView,
): readonly CodegenStructuralField[] | undefined => {
  const desc = program.types.getTypeDesc(typeId);
  if (desc.kind === "structural-object") return desc.fields;
  if (desc.kind === "nominal-object" || desc.kind === "value-object") {
    return program.objects.getInfoByNominal(typeId)?.fields;
  }
  if (desc.kind === "intersection") {
    if (typeof desc.nominal === "number") {
      return structuralFields(desc.nominal, program);
    }
    if (typeof desc.structural === "number") {
      return structuralFields(desc.structural, program);
    }
  }
  return undefined;
};

const assertArrayStorage = (
  typeId: TypeId,
  path: string,
  program: ProgramCodegenView,
): void => {
  const storage = structuralFields(typeId, program)?.find(
    (field) => field.name === "storage",
  );
  if (!storage || program.types.getTypeDesc(storage.type).kind !== "fixed-array") {
    unsupported(typeId, path, program, "array storage layout is unavailable");
  }
};

const primitivePlan = (
  typeId: TypeId,
  program: ProgramCodegenView,
): AutoDtoPrimitivePlan | undefined => {
  if (typeId === program.primitives.bool) return { kind: "bool", typeId };
  if (typeId === program.primitives.i32) return { kind: "i32", typeId };
  if (typeId === program.primitives.i64) return { kind: "i64", typeId };
  if (typeId === program.primitives.f32) return { kind: "f32", typeId };
  if (typeId === program.primitives.f64) return { kind: "f64", typeId };
  if (typeId === program.primitives.void) return { kind: "void", typeId };
  return undefined;
};

const arrayInfo = (
  typeId: TypeId,
  program: ProgramCodegenView,
): { arrayTypeId: TypeId; elementTypeId: TypeId } | undefined => {
  const desc = program.types.getTypeDesc(typeId);
  if (
    (desc.kind === "nominal-object" || desc.kind === "value-object") &&
    isIntrinsic(typeId, STD_INTRINSIC_TYPE.array, program) &&
    desc.typeArgs.length === 1
  ) {
    return { arrayTypeId: typeId, elementTypeId: desc.typeArgs[0]! };
  }
  if (desc.kind === "intersection" && typeof desc.nominal === "number") {
    return arrayInfo(desc.nominal, program);
  }
  return undefined;
};

const isIntrinsic = (
  typeId: TypeId,
  intrinsicType: (typeof STD_INTRINSIC_TYPE)[keyof typeof STD_INTRINSIC_TYPE],
  program: ProgramCodegenView,
): boolean => isStdIntrinsicNominalType({ program, typeId, intrinsicType });

const portableIdentity = (
  typeId: TypeId,
  program: ProgramCodegenView,
): { name: string; documentation?: string } => {
  const desc = program.types.getTypeDesc(typeId);
  const nominal =
    desc.kind === "nominal-object" || desc.kind === "value-object"
      ? typeId
      : desc.kind === "intersection"
        ? desc.nominal
        : undefined;
  const owner =
    typeof nominal === "number"
      ? program.types.getNominalOwner(nominal)
      : undefined;
  if (typeof owner === "number") {
    return {
      name: program.symbols.getName(owner) ?? formatType(typeId, program),
      documentation: program.symbols.getDocumentation(owner),
    };
  }
  const aliases = program.types
    .getAliasSymbols(typeId)
    .map((symbol) => ({
      name: program.symbols.getName(symbol),
      documentation: program.symbols.getDocumentation(symbol),
    }))
    .filter(
      (entry): entry is { name: string; documentation: string | undefined } =>
        typeof entry.name === "string",
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  return aliases[0] ?? { name: formatType(typeId, program) };
};

const portableName = (typeId: TypeId, program: ProgramCodegenView): string =>
  portableIdentity(typeId, program).name;

const variantName = (typeId: TypeId, program: ProgramCodegenView): string => {
  const desc = program.types.getTypeDesc(typeId);
  if (
    (desc.kind === "nominal-object" || desc.kind === "value-object") &&
    desc.name
  ) {
    return desc.name;
  }
  if (desc.kind === "intersection" && typeof desc.nominal === "number") {
    return variantName(desc.nominal, program);
  }
  return formatType(typeId, program);
};

export const formatAutoDtoType = (
  typeId: TypeId,
  program: ProgramCodegenView,
  active = new Set<TypeId>(),
): string => formatType(typeId, program, active);

const formatType = (
  typeId: TypeId,
  program: ProgramCodegenView,
  active = new Set<TypeId>(),
): string => {
  if (active.has(typeId)) return "<recursive>";
  active.add(typeId);
  try {
    const desc = program.types.getTypeDesc(typeId);
    switch (desc.kind) {
      case "primitive":
        return desc.name;
      case "recursive":
        return `recursive<${formatType(desc.body, program, active)}>`;
      case "type-param-ref":
        return `typeparam#${desc.param}`;
      case "nominal-object":
      case "value-object":
      case "trait": {
        const name =
          desc.name ?? program.symbols.getName(desc.owner) ?? `symbol#${desc.owner}`;
        const args = desc.typeArgs.map((arg) => formatType(arg, program, active));
        return args.length > 0 ? `${name}<${args.join(", ")}>` : name;
      }
      case "structural-object":
        return `{ ${desc.fields
          .map(
            (field) =>
              `${field.name}${field.optional ? "?" : ""}: ${formatType(field.type, program, active)}`,
          )
          .join(", ")} }`;
      case "function":
        return `fn(${desc.parameters
          .map((param) => formatType(param.type, program, active))
          .join(", ")}) -> ${formatType(desc.returnType, program, active)}`;
      case "union":
        return desc.members.map((member) => formatType(member, program, active)).join(" | ");
      case "intersection":
        return [desc.nominal, desc.structural, ...(desc.traits ?? [])]
          .filter((part): part is TypeId => typeof part === "number")
          .map((part) => formatType(part, program, active))
          .join(" & ");
      case "fixed-array":
        return `FixedArray<${formatType(desc.element, program, active)}>`;
    }
  } finally {
    active.delete(typeId);
  }
};

const withAlias = (plan: AutoDtoPlan, typeId: TypeId): AutoDtoPlan => {
  if (
    plan.kind === "ref" ||
    plan.kind === "bool" ||
    plan.kind === "i32" ||
    plan.kind === "i64" ||
    plan.kind === "f32" ||
    plan.kind === "f64" ||
    plan.kind === "void" ||
    plan.kind === "string" ||
    plan.kind === "bytes" ||
    plan.typeId === typeId ||
    plan.aliases?.includes(typeId)
  ) {
    return plan;
  }
  return { ...plan, aliases: [...(plan.aliases ?? []), typeId] };
};

const unsupported = (
  typeId: TypeId,
  path: string,
  program: ProgramCodegenView,
  reason = `${formatType(typeId, program)} is not a supported DTO shape`,
): never => {
  throw new AutoDtoPlanError(
    `boundary DTO incompatibility at ${path}: ${reason}; ${DTO_SUMMARY}`,
  );
};
