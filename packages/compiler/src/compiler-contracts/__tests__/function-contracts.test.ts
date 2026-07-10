import { describe, expect, it } from "vitest";
import {
  BOUNDARY_MSGPACK_CONTRACT_IDS,
  BOUNDARY_MSGPACK_CONTRACT_PROVIDER_MODULES,
  COMPILER_FUNCTION_CONTRACTS,
} from "../index.js";

describe("compiler function contract catalog", () => {
  it("defines one boundary-msgpack spec for every stable role", () => {
    const ids = Object.values(BOUNDARY_MSGPACK_CONTRACT_IDS);
    expect(ids).toHaveLength(29);
    expect(new Set(ids).size).toBe(ids.length);
    expect(COMPILER_FUNCTION_CONTRACTS.size).toBe(ids.length);

    ids.forEach((id) => {
      expect(id).toMatch(/^voyd\.std\.boundary\.msgpack\./);
      expect(COMPILER_FUNCTION_CONTRACTS.get(id)).toMatchObject({
        id,
        feature: "boundary-msgpack",
        expectedArity: expect.any(Number),
        signature: {
          typeParameters: 0,
          parameters: expect.any(Array),
          effect: "pure",
        },
      });
      const spec = COMPILER_FUNCTION_CONTRACTS.get(id)!;
      expect(spec.expectedArity).toBe(spec.signature.parameters.length);
      expect(spec.signature.parameters.every((param) => !param.optional)).toBe(true);
    });
  });

  it("centralizes the pre-index loader bootstrap without using it as identity", () => {
    expect(BOUNDARY_MSGPACK_CONTRACT_PROVIDER_MODULES).toEqual([
      "std::msgpack",
      "std::msgpack::fns",
      "std::string",
    ]);
  });
});
