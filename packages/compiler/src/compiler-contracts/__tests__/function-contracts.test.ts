import { describe, expect, it } from "vitest";
import {
  BOUNDARY_MSGPACK_CONTRACT_IDS,
  BOUNDARY_MSGPACK_CONTRACT_PROVIDER_MODULES,
  COMPILER_FUNCTION_CONTRACTS,
  WEB_RENDER_CONTRACT_IDS,
} from "../index.js";

describe("compiler function contract catalog", () => {
  it("defines one boundary-msgpack spec for every stable role", () => {
    const ids = Object.values(BOUNDARY_MSGPACK_CONTRACT_IDS);
    expect(ids).toHaveLength(29);
    expect(new Set(ids).size).toBe(ids.length);
    expect(COMPILER_FUNCTION_CONTRACTS.size).toBe(
      ids.length + Object.keys(WEB_RENDER_CONTRACT_IDS).length,
    );

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

  it("defines retained-callback scope contracts for the web response helpers", () => {
    const ids = Object.values(WEB_RENDER_CONTRACT_IDS);
    const methodAliases = new Set<string>([
      WEB_RENDER_CONTRACT_IDS.responseHtml,
      WEB_RENDER_CONTRACT_IDS.hydratedResponseHtml,
      WEB_RENDER_CONTRACT_IDS.legacyResponseHtml,
      WEB_RENDER_CONTRACT_IDS.legacyHydratedResponseHtml,
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
    expect(BOUNDARY_MSGPACK_CONTRACT_PROVIDER_MODULES).toEqual([
      "std::msgpack",
      "std::msgpack::fns",
      "std::string",
    ]);
  });
});
