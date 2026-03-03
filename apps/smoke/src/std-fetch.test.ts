import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createSdk, type CompileResult } from "@voyd/sdk";
import { createVoydHost } from "@voyd/sdk/js-host";

type FetchRequestProbe = {
  method: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
  body?: string;
  timeoutMillis?: number;
};

const fixtureEntryPath = path.join(import.meta.dirname, "..", "fixtures", "std-fetch.voyd");

const expectCompileSuccess = (
  result: CompileResult
): Extract<CompileResult, { success: true }> => {
  if (!result.success) {
    throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }
  expect(result.success).toBe(true);
  return result;
};

describe("smoke: std fetch", () => {
  let compiled: Extract<CompileResult, { success: true }>;

  beforeAll(async () => {
    const sdk = createSdk();
    compiled = expectCompileSuccess(await sdk.compile({ entryPath: fixtureEntryPath }));
  });

  it("resolves module fetch::get and executes via default fetch adapter", async () => {
    const requests: FetchRequestProbe[] = [];
    const host = await createVoydHost({
      wasm: compiled.wasm,
      defaultAdapters: {
        runtime: "node",
        runtimeHooks: {
          fetchRequest: async (request: FetchRequestProbe) => {
            requests.push(request);
            return {
              status: 204,
              statusText: "No Content",
              headers: [{ name: "content-type", value: "text/plain" }],
              body: "",
            };
          },
        },
      },
    });

    await expect(host.run<number>("module_get_probe")).resolves.toBe(204);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual(
      expect.objectContaining({ method: "GET", url: "https://example.test/module" })
    );
  });

  it("keeps request construction available through FetchRequest::from_get", async () => {
    const requests: FetchRequestProbe[] = [];
    const host = await createVoydHost({
      wasm: compiled.wasm,
      defaultAdapters: {
        runtime: "node",
        runtimeHooks: {
          fetchRequest: async (request: FetchRequestProbe) => {
            requests.push(request);
            return {
              status: 205,
              statusText: "Reset Content",
              headers: [{ name: "content-type", value: "text/plain" }],
              body: "",
            };
          },
        },
      },
    });

    await expect(host.run<number>("request_factory_probe")).resolves.toBe(205);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual(
      expect.objectContaining({ method: "GET", url: "https://example.test/factory" })
    );
  });
});
