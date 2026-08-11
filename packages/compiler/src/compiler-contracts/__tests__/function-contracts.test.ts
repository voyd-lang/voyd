import { describe, expect, it } from "vitest";
import {
  MSGPACK_HOST_TRANSPORT_CONTRACT_IDS,
  MSGPACK_HOST_TRANSPORT_CONTRACT_PROVIDER_MODULES,
  COMPILER_FUNCTION_CONTRACTS,
  DTO_DATA_CONTRACT_IDS,
  WEB_RENDER_CONTRACT_IDS,
} from "../index.js";

describe("compiler function contract catalog", () => {
  it("defines one host-transport-msgpack spec for every stable role", () => {
    const ids = Object.values(MSGPACK_HOST_TRANSPORT_CONTRACT_IDS);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(ids.length);
    expect(COMPILER_FUNCTION_CONTRACTS.size).toBe(
      ids.length +
        Object.keys(DTO_DATA_CONTRACT_IDS).length +
        Object.keys(WEB_RENDER_CONTRACT_IDS).length,
    );

    ids.forEach((id) => {
      expect(id).toMatch(/^voyd\.std\.host-transport\.msgpack\./);
      expect(COMPILER_FUNCTION_CONTRACTS.get(id)).toMatchObject({
        id,
        feature: "host-transport-msgpack",
        expectedArity: expect.any(Number),
        signature: {
          typeParameters: 0,
          parameters: expect.any(Array),
          effect: "pure",
        },
      });
      const spec = COMPILER_FUNCTION_CONTRACTS.get(id)!;
      expect(spec.expectedArity).toBe(spec.signature.parameters.length);
      expect(spec.signature.parameters.every((param) => !param.optional)).toBe(
        true,
      );
    });
  });

  it("defines one provider-neutral data spec for every stable role", () => {
    const ids = Object.values(DTO_DATA_CONTRACT_IDS);
    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(ids.length);

    ids.forEach((id) => {
      expect(id).toMatch(/^voyd\.std\.data\./);
      expect(COMPILER_FUNCTION_CONTRACTS.get(id)).toMatchObject({
        id,
        feature: "dto-data",
        expectedArity: expect.any(Number),
      });
    });
  });

  it("defines retained-callback scope contracts for the web response helpers", () => {
    const ids = Object.values(WEB_RENDER_CONTRACT_IDS);
    const methodAliases = new Set<string>([
      WEB_RENDER_CONTRACT_IDS.responseHtml,
      WEB_RENDER_CONTRACT_IDS.hydratedResponseHtml,
    ]);
    expect(new Set(ids).size).toBe(ids.length);

    ids.forEach((id) => {
      expect(COMPILER_FUNCTION_CONTRACTS.get(id)).toMatchObject({
        id,
        feature: "retained-callback-call-scope",
        overloadPreference: "least-generic",
        provider: { namespace: "pkg", packageName: "web" },
      });
      expect(COMPILER_FUNCTION_CONTRACTS.get(id)?.methodAlias).toBe(
        methodAliases.has(id) ? "html" : undefined,
      );
    });
  });

  it("centralizes the pre-index loader bootstrap without using it as identity", () => {
    expect(MSGPACK_HOST_TRANSPORT_CONTRACT_PROVIDER_MODULES).toEqual([
      "std::msgpack",
      "std::msgpack::fns",
      "std::string",
    ]);
  });
});
