import http from "node:http";
import net from "node:net";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createSdk, type CompileResult } from "@voyd-lang/sdk";
import { createVoydHost } from "@voyd-lang/sdk/js-host";

type HttpClientRequestProbe = {
  method: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
  body: Uint8Array;
  timeoutMillis?: number;
};

const fixtureEntryPath = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "std-http.voyd",
);

const expectCompileSuccess = (
  result: CompileResult,
): Extract<CompileResult, { success: true }> => {
  if (!result.success) {
    throw new Error(
      result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    );
  }
  expect(result.success).toBe(true);
  return result;
};

const findFreePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate tcp port")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });

const httpGet = (
  url: string,
  timeoutMs = 2000,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> =>
  new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body,
        });
      });
    });
    request.once("error", reject);
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`timed out waiting for ${url}`));
    });
  });

const retryHttpGet = async (
  url: string,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await httpGet(url);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

describe("smoke: std http", () => {
  let compiled: Extract<CompileResult, { success: true }>;

  beforeAll(async () => {
    const sdk = createSdk();
    compiled = expectCompileSuccess(
      await sdk.compile({ entryPath: fixtureEntryPath }),
    );
  });

  it("resolves module http::client::get and executes via default http-client adapter", async () => {
    const requests: HttpClientRequestProbe[] = [];
    const host = await createVoydHost({
      wasm: compiled.wasm,
      defaultAdapters: {
        runtime: "node",
        runtimeHooks: {
          httpClientRequest: async (request: HttpClientRequestProbe) => {
            requests.push(request);
            return {
              status: 204,
              reason: "No Content",
              headers: [{ name: "content-type", value: "text/plain" }],
              body: new Uint8Array(),
            };
          },
        },
      },
    });

    await expect(host.run<number>("module_get_probe")).resolves.toBe(204);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual(
      expect.objectContaining({
        method: "GET",
        url: "https://example.test/module",
      }),
    );
  });

  it("keeps request construction available through ClientRequest::get", async () => {
    const requests: HttpClientRequestProbe[] = [];
    const host = await createVoydHost({
      wasm: compiled.wasm,
      defaultAdapters: {
        runtime: "node",
        runtimeHooks: {
          httpClientRequest: async (request: HttpClientRequestProbe) => {
            requests.push(request);
            return {
              status: 205,
              reason: "Reset Content",
              headers: [{ name: "content-type", value: "text/plain" }],
              body: new Uint8Array(),
            };
          },
        },
      },
    });

    await expect(host.run<number>("request_factory_probe")).resolves.toBe(205);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual(
      expect.objectContaining({
        method: "GET",
        url: "https://example.test/factory",
      }),
    );
  });

  it("serves one inbound Node HTTP request through std::http::server", async () => {
    const port = await findFreePort();
    process.env.VOYD_HTTP_SMOKE_PORT = String(port);
    const host = await createVoydHost({
      wasm: compiled.wasm,
      defaultAdapters: { runtime: "node" },
    });

    const run = host.run<number>("serve_once_from_env");
    const response = await retryHttpGet(
      `http://127.0.0.1:${port}/hello?name=voyd`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toBe("served");
    expect(response.headers["x-voyd-method"]).toBe("GET");
    await expect(run).resolves.toBe(200);
  });

  it("detaches std::http::server request handlers from the accept loop", async () => {
    const port = await findFreePort();
    process.env.VOYD_HTTP_SMOKE_PORT = String(port);
    const unhandledFailures: Error[] = [];
    const host = await createVoydHost({
      wasm: compiled.wasm,
      scheduler: {
        onUnhandledTaskFailed: (error) => unhandledFailures.push(error),
      },
      defaultAdapters: { runtime: "node" },
    });

    const run = host.runManaged<number>("serve_detached_from_env");
    await retryHttpGet(`http://127.0.0.1:${port}/ready`);

    const slow = httpGet(`http://127.0.0.1:${port}/slow`, 1000);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const fast = await httpGet(`http://127.0.0.1:${port}/fast`, 100);

    expect(fast.status).toBe(200);
    expect(fast.body).toBe("fast");
    await expect(slow).resolves.toMatchObject({ status: 200, body: "slow" });
    expect(unhandledFailures).toEqual([]);
    expect(run.cancel("test complete")).toBe(true);
    await expect(run.outcome).resolves.toMatchObject({ kind: "cancelled" });
  });

  it("responds from detached std::http::server request handlers", async () => {
    const port = await findFreePort();
    process.env.VOYD_HTTP_SMOKE_PORT = String(port);
    const unhandledFailures: Error[] = [];
    const host = await createVoydHost({
      wasm: compiled.wasm,
      scheduler: {
        onUnhandledTaskFailed: (error) => unhandledFailures.push(error),
      },
      defaultAdapters: { runtime: "node" },
    });

    const run = host.runManaged<number>("serve_detached_static_from_env");
    await new Promise((resolve) => setTimeout(resolve, 100));

    const response = await httpGet(
      `http://127.0.0.1:${port}/static`,
      100,
    ).catch((error) => {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; detached failures: ${unhandledFailures.map((failure) => failure.stack ?? failure.message).join("\n")}`,
      );
    });

    expect(response.status).toBe(200);
    expect(response.body).toBe("static");
    expect(unhandledFailures).toEqual([]);
    expect(run.cancel("test complete")).toBe(true);
    await expect(run.outcome).resolves.toMatchObject({ kind: "cancelled" });
  });
});
