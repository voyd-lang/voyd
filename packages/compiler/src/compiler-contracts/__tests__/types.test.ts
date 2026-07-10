import { describe, expect, it } from "vitest";
import type { ProgramCodegenView } from "../../semantics/codegen-view/index.js";
import {
  isStdIntrinsicNominalType,
  STD_INTRINSIC_TYPE,
  type StdIntrinsicTypeContractId,
} from "../types.js";

describe("std intrinsic nominal type contracts", () => {
  it("does not recognize user types by a compiler-known source name", () => {
    const program = programWithNominal({
      name: "Array",
      packageId: "src",
      intrinsicType: undefined,
      validatedContractId: undefined,
    });

    expect(
      isStdIntrinsicNominalType({
        program,
        typeId: 10,
        intrinsicType: STD_INTRINSIC_TYPE.array,
      }),
    ).toBe(false);
  });

  it("requires both std ownership and the exact intrinsic type id", () => {
    const program = programWithNominal({
      name: "RenamedArray",
      packageId: "std",
      intrinsicType: STD_INTRINSIC_TYPE.array,
      validatedContractId: STD_INTRINSIC_TYPE.array,
    });

    expect(
      isStdIntrinsicNominalType({
        program,
        typeId: 11,
        intrinsicType: STD_INTRINSIC_TYPE.array,
      }),
    ).toBe(true);
    expect(
      isStdIntrinsicNominalType({
        program,
        typeId: 11,
        intrinsicType: STD_INTRINSIC_TYPE.string,
      }),
    ).toBe(false);
  });

  it("does not trust raw intrinsic metadata without a validated provider", () => {
    const program = programWithNominal({
      name: "MalformedArray",
      packageId: "std",
      intrinsicType: STD_INTRINSIC_TYPE.array,
      validatedContractId: undefined,
    });

    expect(
      isStdIntrinsicNominalType({
        program,
        typeId: 11,
        intrinsicType: STD_INTRINSIC_TYPE.array,
      }),
    ).toBe(false);
  });

  it("follows the nominal component of an intersection", () => {
    const nominal = programWithNominal({
      name: "String",
      packageId: "std",
      intrinsicType: STD_INTRINSIC_TYPE.string,
      validatedContractId: STD_INTRINSIC_TYPE.string,
    });
    const program = {
      ...nominal,
      types: {
        ...nominal.types,
        getTypeDesc: (typeId: number) =>
          typeId === 20
            ? { kind: "intersection", nominal: 12, structural: 13 }
            : nominal.types.getTypeDesc(typeId),
      },
    } as ProgramCodegenView;

    expect(
      isStdIntrinsicNominalType({
        program,
        typeId: 20,
        intrinsicType: STD_INTRINSIC_TYPE.string,
      }),
    ).toBe(true);
  });
});

const programWithNominal = ({
  name,
  packageId,
  intrinsicType,
  validatedContractId,
}: {
  name: string;
  packageId: string;
  intrinsicType: string | undefined;
  validatedContractId: StdIntrinsicTypeContractId | undefined;
}): ProgramCodegenView =>
  ({
    types: {
      getTypeDesc: () => ({
        kind: "nominal-object",
        name,
        owner: 3,
        typeArgs: [],
      }),
    },
    symbols: {
      getPackageId: () => packageId,
      getIntrinsicType: () => intrinsicType,
      getStdIntrinsicTypeContract: () =>
        validatedContractId
          ? { id: validatedContractId, providerKind: "nominal-object" }
          : undefined,
    },
  }) as unknown as ProgramCodegenView;
