import { describe, expect, it } from "vitest";
import {
  COMPILER_FUNCTION_CONTRACTS,
  CUSTOM_DTO_CONTRACT,
  CUSTOM_DTO_CONTRACT_ID,
  HOST_TRANSPORT_PROVIDER_CONTRACT,
  HOST_TRANSPORT_PROVIDER_CONTRACT_ID,
  SELECTED_HOST_TRANSPORT_PROVIDER_MODULES,
  DTO_DATA_CONTRACT_IDS,
  WEB_RENDER_CONTRACT_IDS,
} from "../index.js";

describe("compiler function contract catalog", () => {
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
    expect(SELECTED_HOST_TRANSPORT_PROVIDER_MODULES).toEqual([
      "std::msgpack",
      "std::msgpack::fns",
      "std::string",
    ]);
  });

  it("defines the compiler-known host transport provider trait", () => {
    expect(HOST_TRANSPORT_PROVIDER_CONTRACT).toMatchObject({
      id: HOST_TRANSPORT_PROVIDER_CONTRACT_ID,
      expectedTypeParameters: 2,
      methods: [
        { role: "createReader", name: "create_reader", expectedArity: 2 },
        { role: "readerComplete", name: "reader_complete", expectedArity: 1 },
        { role: "createWriter", name: "create_writer", expectedArity: 2 },
        { role: "finishWriter", name: "finish_writer", expectedArity: 1 },
      ],
    });
  });

  it("declares the CustomDto callback boundary", () => {
    expect(CUSTOM_DTO_CONTRACT).toMatchObject({
      id: CUSTOM_DTO_CONTRACT_ID,
      expectedTypeParameters: 2,
      methods: [
        {
          name: "write",
          expectedArity: 1,
          ordinaryMutation: { invokesUnknownCallback: true },
        },
        { name: "read", expectedArity: 1 },
      ],
    });
  });
});
