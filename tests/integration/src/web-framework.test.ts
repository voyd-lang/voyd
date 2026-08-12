import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createSdk, type CompileResult } from "@voyd-lang/sdk";
import { createVoydHost } from "@voyd-lang/sdk/js-host";
import {
  createRetainedEventHandlerRegistry,
  type DefaultAdapterRuntimeHooks,
  type RetainedEventHandlerRegistry,
} from "@voyd-lang/js-host";

const fixtureRoot = path.resolve(import.meta.dirname, "../fixtures");
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const WEB_FRAMEWORK_COMPILE_TIMEOUT_MS = 240_000;

const expectCompileSuccess = (
  result: CompileResult,
): Extract<CompileResult, { success: true }> => {
  if (!result.success) {
    throw new Error(JSON.stringify(result.diagnostics, null, 2));
  }
  expect(result.success).toBe(true);
  return result;
};

const webFrameworkSdk = createSdk();
let webFrameworkFixtureCompile: Promise<CompileResult> | undefined;
const compileWebFrameworkFixture = async (): Promise<
  Extract<CompileResult, { success: true }>
> => {
  webFrameworkFixtureCompile ??= webFrameworkSdk.compile({
    entryPath: path.join(fixtureRoot, "web-framework.voyd"),
    roots: {
      src: fixtureRoot,
      pkgDirs: [path.join(repoRoot, "packages")],
    },
  });
  return expectCompileSuccess(await webFrameworkFixtureCompile);
};

const waitFor = async (
  predicate: () => boolean,
  label: string,
): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
};

type HookRequest = {
  requestId: number;
  method: string;
  path: string;
  headers: Array<{ name: string; value: string }>;
  body: Uint8Array;
  bodyStreaming?: boolean;
};

type HookResponse = {
  requestId: number;
  status: number;
  body: Uint8Array;
};

type HookResponseHead = Omit<HookResponse, "body"> & {
  headers: Array<{ name: string; value: string }>;
};

const createHttpServerHarness = (): {
  enqueueRequest: (requestId: number, requestPath: string) => void;
  enqueueStreamingRequest: (
    requestId: number,
    requestPath: string,
    chunks: Uint8Array[],
  ) => void;
  responses: HookResponse[];
  responseHeads: HookResponseHead[];
  responseChunks: Array<{ requestId: number; chunk: Uint8Array }>;
  finishedResponses: number[];
  runtimeHooks: DefaultAdapterRuntimeHooks;
} => {
  const queuedRequests: HookRequest[] = [];
  const acceptWaiters: Array<(request: HookRequest) => void> = [];
  const responses: HookResponse[] = [];
  const responseHeads: HookResponseHead[] = [];
  const responseChunks: Array<{ requestId: number; chunk: Uint8Array }> = [];
  const finishedResponses: number[] = [];
  const requestChunks = new Map<number, Uint8Array[]>();
  const enqueueRequest = (requestId: number, requestPath: string): void => {
    const request = {
      requestId,
      method: "GET",
      path: requestPath,
      headers: [],
      body: new Uint8Array(),
    };
    const waiter = acceptWaiters.shift();
    if (waiter) {
      waiter(request);
      return;
    }
    queuedRequests.push(request);
  };
  const enqueueStreamingRequest = (
    requestId: number,
    requestPath: string,
    chunks: Uint8Array[],
  ): void => {
    requestChunks.set(requestId, [...chunks]);
    const request: HookRequest = {
      requestId,
      method: "POST",
      path: requestPath,
      headers: [],
      body: new Uint8Array(),
      bodyStreaming: true,
    };
    const waiter = acceptWaiters.shift();
    if (waiter) {
      waiter(request);
      return;
    }
    queuedRequests.push(request);
  };

  return {
    enqueueRequest,
    enqueueStreamingRequest,
    responses,
    responseHeads,
    responseChunks,
    finishedResponses,
    runtimeHooks: {
      httpServerListen: async () => 1,
      httpServerAccept: async () => {
        const queued = queuedRequests.shift();
        if (queued) {
          return queued;
        }
        return await new Promise<HookRequest>((resolve) =>
          acceptWaiters.push(resolve),
        );
      },
      httpServerReadRequest: async (requestId) => {
        const chunks = requestChunks.get(requestId) ?? [];
        const chunk = chunks.shift() ?? new Uint8Array();
        const done = chunks.length === 0;
        if (done) {
          requestChunks.delete(requestId);
        }
        return { requestId, chunk, done };
      },
      httpServerRespond: async (response) => {
        responses.push(response);
      },
      httpServerStartResponse: async (response) => {
        responseHeads.push(response);
      },
      httpServerWriteResponse: async (response) => {
        responseChunks.push(response);
      },
      httpServerFinishResponse: async (requestId) => {
        finishedResponses.push(requestId);
      },
      httpServerClose: async () => undefined,
    },
  };
};

describe("integration: pkg::web", () => {
  beforeAll(async () => {
    await compileWebFrameworkFixture();
  }, WEB_FRAMEWORK_COMPILE_TIMEOUT_MS);

  it("streams request bodies through Web Context when opted in", async () => {
    const result = await compileWebFrameworkFixture();
    const server = createHttpServerHarness();
    const host = await createVoydHost({
      wasm: result.wasm,
      defaultAdapters: {
        runtime: "node",
        runtimeHooks: server.runtimeHooks,
      },
    });
    const run = host.runManaged<number>("serve_streaming_body_probe");
    server.enqueueStreamingRequest(2, "/upload", [
      new TextEncoder().encode("first-"),
      new TextEncoder().encode("second"),
    ]);
    await waitFor(() => server.responses.length === 1, "streaming upload response");

    expect(new TextDecoder().decode(server.responses[0]!.body)).toBe("12");

    expect(run.cancel("test complete")).toBe(true);
    await expect(run.outcome).resolves.toMatchObject({ kind: "cancelled" });
  });

  it("preserves payload-too-large status while lazily buffering ordinary routes", async () => {
    const result = await compileWebFrameworkFixture();
    const server = createHttpServerHarness();
    const host = await createVoydHost({
      wasm: result.wasm,
      defaultAdapters: {
        runtime: "node",
        runtimeHooks: {
          ...server.runtimeHooks,
          httpServerReadRequest: async () => {
            throw Object.assign(new Error("request body exceeds max_body_bytes (4)"), {
              code: 3,
            });
          },
        },
      },
    });
    const run = host.runManaged<number>("serve_streaming_buffered_body_probe");
    server.enqueueStreamingRequest(3, "/buffered", [
      new TextEncoder().encode("oversized"),
    ]);
    await waitFor(() => server.responses.length === 1, "buffered body rejection");

    expect(server.responses[0]).toMatchObject({
      requestId: 3,
      status: 413,
    });

    expect(run.cancel("test complete")).toBe(true);
    await expect(run.outcome).resolves.toMatchObject({ kind: "cancelled" });
  });

  it("generates documented OpenAPI schemas through the public package API", async () => {
    const result = await compileWebFrameworkFixture();
    const schema = await result.run<string>({ entryName: "openapi_schema_probe" });

    expect(schema).toContain('"/articles/{id}"');
    expect(schema).toContain('"required":["title"]');
    expect(schema).toContain("Stable article identifier.");
    expect(schema).toContain("Reader-visible article title.");
  });

  it("derives OpenAPI from the public app route API", async () => {
    const result = await compileWebFrameworkFixture();
    const schema = await result.run<string>({
      entryName: "automatic_openapi_schema_probe",
    });

    expect(schema).toContain('"/articles"');
    expect(schema).toContain('"201"');
    expect(schema).toContain('"operationId":"createArticle"');
    expect(schema).toContain("Reader-visible article title.");
    expect(schema).not.toContain('\"/manual-openapi.json\"');
  });

  it("serves formatted SSE through the Web router and host stream lifecycle", async () => {
    const result = await compileWebFrameworkFixture();
    const server = createHttpServerHarness();
    const host = await createVoydHost({
      wasm: result.wasm,
      defaultAdapters: {
        runtime: "node",
        runtimeHooks: server.runtimeHooks,
      },
    });
    const run = host.runManaged<number>("serve_sse_probe");
    server.enqueueRequest(1, "/events");
    await waitFor(
      () => server.finishedResponses.includes(1),
      "SSE stream completion",
    );

    expect(server.responseHeads).toEqual([
      expect.objectContaining({
        requestId: 1,
        status: 200,
        headers: expect.arrayContaining([
          {
            name: "content-type",
            value: "text/event-stream; charset=utf-8",
          },
        ]),
      }),
    ]);
    expect(
      new TextDecoder().decode(
        Uint8Array.from(
          server.responseChunks.flatMap((entry) => [...entry.chunk]),
        ),
      ),
    ).toBe("event: status\nid: 1\ndata: ready\n\n");

    expect(run.cancel("test complete")).toBe(true);
    await expect(run.outcome).resolves.toMatchObject({ kind: "cancelled" });
  });

  it("releases server-rendered callbacks after success and failure", async () => {
    const result = await compileWebFrameworkFixture();
    const server = createHttpServerHarness();
    const failures: Error[] = [];
    const host = await createVoydHost({
      wasm: result.wasm,
      scheduler: {
        onUnhandledTaskFailed: (error) => failures.push(error),
      },
      defaultAdapters: {
        runtime: "node",
        runtimeHooks: server.runtimeHooks,
      },
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        host.run<string>("direct_ssr_callback_scope_probe"),
      ).resolves.toContain("<button>Rendered</button>");
      expect(host.retainedCallbacks.size()).toBe(0);
    }
    await expect(
      host.run<string>("direct_typed_ssr_callback_scope_probe"),
    ).resolves.toContain("<textarea>Typed</textarea>");
    expect(host.retainedCallbacks.size()).toBe(0);
    await expect(
      host.run<string>("aliased_ssr_callback_scope_probe"),
    ).resolves.toContain("<button>Rendered</button>");
    expect(host.retainedCallbacks.size()).toBe(0);
    await expect(
      host.run<string>("qualified_ssr_callback_scope_probe"),
    ).resolves.toContain("<button>Rendered</button>");
    expect(host.retainedCallbacks.size()).toBe(0);
    await expect(
      host.run<string>("html_response_callback_scope_probe"),
    ).resolves.toContain("<button>Rendered</button>");
    expect(host.retainedCallbacks.size()).toBe(0);
    await expect(
      host.run<string>("explicit_generic_html_response_callback_scope_probe"),
    ).resolves.toContain("<button>Rendered</button>");
    expect(host.retainedCallbacks.size()).toBe(0);
    await expect(
      host.run<string>("qualified_html_function_callback_scope_probe"),
    ).resolves.toContain("<button>Rendered</button>");
    expect(host.retainedCallbacks.size()).toBe(0);
    await expect(
      host.run<string>("legacy_response_html_callback_scope_probe"),
    ).resolves.toContain("<button>Rendered</button>");
    expect(host.retainedCallbacks.size()).toBe(0);
    await expect(
      host.run<string>("response_value_html_callback_scope_probe"),
    ).resolves.toContain("<button>Rendered</button>");
    expect(host.retainedCallbacks.size()).toBe(0);
    await expect(
      host.run<string>("aliased_response_html_callback_scope_probe"),
    ).resolves.toContain("<button>Rendered</button>");
    expect(host.retainedCallbacks.size()).toBe(0);
    await expect(
      host.run<string>("explicit_generic_response_html_callback_scope_probe"),
    ).resolves.toContain("<button>Rendered</button>");
    expect(host.retainedCallbacks.size()).toBe(0);
    await expect(
      host.run<string>("hydrated_response_html_callback_scope_probe"),
    ).resolves.toContain('data-voyd-hydration-id="probe"');
    expect(host.retainedCallbacks.size()).toBe(0);
    await expect(
      host.run<string>("hydrated_html_response_callback_scope_probe"),
    ).resolves.toContain('data-voyd-hydration-id="named-probe"');
    expect(host.retainedCallbacks.size()).toBe(0);
    await expect(host.run("direct_ssr_render_failure_probe")).rejects.toThrow();
    expect(host.retainedCallbacks.size()).toBe(0);
    await expect(host.run("direct_ssr_view_failure_probe")).rejects.toThrow();
    expect(host.retainedCallbacks.size()).toBe(0);
    await expect(host.run("direct_hydration_failure_probe")).rejects.toThrow();
    expect(host.retainedCallbacks.size()).toBe(0);
    await expect(
      host.run<string>("prebuilt_ssr_callback_scope_probe"),
    ).resolves.toContain("<button>Rendered</button>");
    expect(host.retainedCallbacks.size()).toBe(0);
    await expect(
      host.run<string>("mapped_ssr_callback_scope_probe"),
    ).resolves.toContain("<button>Mapped</button>");
    expect(host.retainedCallbacks.size()).toBe(0);

    await host.run("browser_callback_lifetime_probe");
    expect(host.retainedCallbacks.size()).toBe(1);
    host.retainedCallbacks.clear();

    const run = host.runManaged<number>("serve_ssr_callback_scope_probe");

    for (const [requestId, requestPath] of [
      [1, "/ok"],
      [2, "/static"],
      [3, "/ok"],
    ] as const) {
      server.enqueueRequest(requestId, requestPath);
      await waitFor(
        () => server.responses.length === requestId,
        `response ${requestId}`,
      );
      expect(host.retainedCallbacks.size()).toBe(0);
    }
    expect(new TextDecoder().decode(server.responses[0]!.body)).toContain(
      "<button>Rendered</button>",
    );

    server.enqueueRequest(4, "/fail");
    await waitFor(() => failures.length === 1, "failed render cleanup");
    expect(failures[0]!.message).toContain(
      "void VX HTML element cannot have children: input",
    );
    expect(host.retainedCallbacks.size()).toBe(0);

    expect(run.cancel("test complete")).toBe(true);
    await expect(run.outcome).resolves.toMatchObject({ kind: "cancelled" });

    const baseRegistry = createRetainedEventHandlerRegistry();
    const throwingRegistry: RetainedEventHandlerRegistry = {
      ...baseRegistry,
      releaseMany: (ids) => {
        baseRegistry.releaseMany(ids);
        throw new Error("injected cleanup failure");
      },
    };
    const cleanupFailures: Error[] = [];
    const cleanupLogs = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const cleanupServer = createHttpServerHarness();
    cleanupServer.enqueueRequest(5, "/fail");
    const cleanupHost = await createVoydHost({
      wasm: result.wasm,
      retainedCallbacks: throwingRegistry,
      scheduler: {
        onUnhandledTaskFailed: (error) => cleanupFailures.push(error),
      },
      defaultAdapters: {
        runtime: "node",
        runtimeHooks: cleanupServer.runtimeHooks,
      },
    });
    const cleanupRun = cleanupHost.runManaged<number>(
      "serve_ssr_callback_scope_probe",
    );
    try {
      await waitFor(
        () => cleanupFailures.length === 1,
        "cleanup failure report",
      );
      expect(cleanupFailures[0]!.message).toContain(
        "void VX HTML element cannot have children: input",
      );
      expect(cleanupLogs).toHaveBeenCalledWith(
        expect.stringContaining("injected cleanup failure"),
      );
      expect(cleanupHost.retainedCallbacks.size()).toBe(0);
      expect(cleanupRun.cancel("failure case complete")).toBe(true);
      await expect(cleanupRun.outcome).resolves.toMatchObject({
        kind: "cancelled",
      });

      const successfulCleanupRun = cleanupHost.runManaged<number>(
        "effectful_ssr_callback_scope_probe",
      );
      await expect(successfulCleanupRun.outcome).resolves.toMatchObject({
        kind: "failed",
        error: expect.objectContaining({
          message: "injected cleanup failure",
        }),
      });
      expect(cleanupHost.retainedCallbacks.size()).toBe(0);
    } finally {
      cleanupLogs.mockRestore();
      cleanupRun.cancel("test complete");
      await cleanupRun.outcome;
    }
  });

  it("routes requests and builds apps through the public package API", async () => {
    const result = await compileWebFrameworkFixture();

    await expect(
      result.run<number>({ entryName: "route_probe" }),
    ).resolves.toBe(405);
    await expect(
      result.run<number>({ entryName: "builder_probe" }),
    ).resolves.toBe(200);
    await expect(
      result.run<number>({ entryName: "all_json_response_probe" }),
    ).resolves.toBe(200);
    await expect(
      result.run<number>({ entryName: "option_response_probe" }),
    ).resolves.toBe(404);
    await expect(
      result.run<number>({ entryName: "router_export_probe" }),
    ).resolves.toBe(200);
  });

  it("converts option responses from extracted route handlers", async () => {
    const result = await compileWebFrameworkFixture();

    await expect(
      result.run<number>({ entryName: "route_option_response_probe" }),
    ).resolves.toBe(200);
  });

  it("supports body and auth policies on method helpers", async () => {
    const result = await compileWebFrameworkFixture();

    await expect(
      result.run<number>({ entryName: "method_body_route_probe" }),
    ).resolves.toBe(200);
  }, WEB_FRAMEWORK_COMPILE_TIMEOUT_MS);

  it("cancels route handlers that exceed timeout policies", async () => {
    const result = await compileWebFrameworkFixture();

    await expect(
      result.run<number>({
        entryName: "timeout_route_probe",
        defaultAdapters: true,
      }),
    ).resolves.toBe(504);
  }, WEB_FRAMEWORK_COMPILE_TIMEOUT_MS);

  it("converts responses from free get helpers", async () => {
    const result = await compileWebFrameworkFixture();

    await expect(
      result.run<number>({ entryName: "free_get_response_probe" }),
    ).resolves.toBe(200);
  }, WEB_FRAMEWORK_COMPILE_TIMEOUT_MS);

  it("rejects unknown route DSL extractor parameter names", async () => {
    const sdk = webFrameworkSdk;
    const result = await sdk.compile({
      source: `
use pkg::web::all
use std::string::type::String

type UserParams = {
  id: String
}

fn invalid_route_dsl()
  serve(port: 3000) routes():
    get("/users/:id") do(user: UserParams):
      user.id
`,
      roots: {
        src: fixtureRoot,
        pkgDirs: [path.join(repoRoot, "packages")],
      },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error(
        "Expected unknown route DSL extractor name to fail compilation",
      );
    }

    expect(
      result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    ).toContain(
      "web route handler extractor parameters must be named params, query, headers",
    );
  });

  it("supports hygienic route DSL imports from root, all, and dsl", async () => {
    await compileWebFrameworkFixture();
  }, WEB_FRAMEWORK_COMPILE_TIMEOUT_MS);
});
