import type { ProgramCodegenView } from "../semantics/codegen-view/index.js";
import type { TypeId } from "../semantics/ids.js";

export const STD_INTRINSIC_TYPE = {
  array: "voyd.std.array",
  range: "voyd.std.range",
  string: "voyd.std.string",
  stringSlice: "voyd.std.string-slice",
  sharedCell: "voyd.std.shared-cell",
  optionalSome: "optional-some",
  optionalNone: "optional-none",
} as const;

export type StdIntrinsicTypeId =
  (typeof STD_INTRINSIC_TYPE)[keyof typeof STD_INTRINSIC_TYPE];

export type StdIntrinsicTypeProviderKind =
  | "nominal-object"
  | "value-object";

const NOMINAL_PROVIDER_KINDS = [
  "nominal-object",
] as const satisfies readonly StdIntrinsicTypeProviderKind[];

/**
 * Compiler-owned intrinsic type roles. Only these namespaced IDs are reserved;
 * legacy optional IDs become contracts only when their providers belong to std.
 */
const stdIntrinsicTypeContractSpecs = [
  {
    id: STD_INTRINSIC_TYPE.array,
    providerKinds: NOMINAL_PROVIDER_KINDS,
    outsideStd: "reject",
  },
  {
    id: STD_INTRINSIC_TYPE.range,
    providerKinds: NOMINAL_PROVIDER_KINDS,
    outsideStd: "reject",
  },
  {
    id: STD_INTRINSIC_TYPE.string,
    providerKinds: NOMINAL_PROVIDER_KINDS,
    outsideStd: "reject",
  },
  {
    id: STD_INTRINSIC_TYPE.stringSlice,
    providerKinds: NOMINAL_PROVIDER_KINDS,
    outsideStd: "reject",
  },
  {
    id: STD_INTRINSIC_TYPE.sharedCell,
    providerKinds: NOMINAL_PROVIDER_KINDS,
    outsideStd: "reject",
  },
  {
    id: STD_INTRINSIC_TYPE.optionalSome,
    providerKinds: NOMINAL_PROVIDER_KINDS,
    outsideStd: "general-metadata",
  },
  {
    id: STD_INTRINSIC_TYPE.optionalNone,
    providerKinds: NOMINAL_PROVIDER_KINDS,
    outsideStd: "general-metadata",
  },
] as const;

export type StdIntrinsicTypeContractId =
  (typeof stdIntrinsicTypeContractSpecs)[number]["id"];

export type StdIntrinsicTypeContractSpec = {
  readonly id: StdIntrinsicTypeContractId;
  readonly providerKinds: readonly StdIntrinsicTypeProviderKind[];
  readonly outsideStd: "reject" | "general-metadata";
};

export type StdIntrinsicTypeContractProvider = {
  readonly id: StdIntrinsicTypeContractId;
  readonly providerKind: StdIntrinsicTypeProviderKind;
};

export const STD_INTRINSIC_TYPE_CONTRACTS: ReadonlyMap<
  StdIntrinsicTypeContractId,
  StdIntrinsicTypeContractSpec
> = new Map(
  stdIntrinsicTypeContractSpecs.map(
    (spec): [StdIntrinsicTypeContractId, StdIntrinsicTypeContractSpec] => [
      spec.id,
      spec,
    ],
  ),
);

export const getStdIntrinsicTypeContractSpec = (
  id: string,
): StdIntrinsicTypeContractSpec | undefined =>
  STD_INTRINSIC_TYPE_CONTRACTS.get(id as StdIntrinsicTypeContractId);

/** Matches compiler-owned std nominal identity, never source names or shape. */
export const isStdIntrinsicNominalType = ({
  program,
  typeId,
  intrinsicType,
}: {
  program: ProgramCodegenView;
  typeId: TypeId;
  intrinsicType: StdIntrinsicTypeId;
}): boolean => {
  const desc = program.types.getTypeDesc(typeId);
  if (desc.kind === "intersection" && typeof desc.nominal === "number") {
    return isStdIntrinsicNominalType({
      program,
      typeId: desc.nominal,
      intrinsicType,
    });
  }
  if (desc.kind !== "nominal-object" && desc.kind !== "value-object") {
    return false;
  }
  return (
    program.symbols.getPackageId(desc.owner) === "std" &&
    program.symbols.getStdIntrinsicTypeContract(desc.owner)?.id === intrinsicType
  );
};
