import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSdk, type CompileResult } from "@voyd-lang/sdk";
import { createVoydHost } from "@voyd-lang/sdk/js-host";
import {
  createRetainedEventHandlerRegistry,
  type DefaultAdapterRuntimeHooks,
  type RetainedEventHandlerRegistry,
} from "@voyd-lang/js-host";

const fixtureRoot = path.resolve(import.meta.dirname, "../fixtures");
const repoRoot = path.resolve(import.meta.dirname, "../../..");

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

let webFrameworkFixtureCompile: Promise<CompileResult> | undefined;
const compileWebFrameworkFixture = async (): Promise<
  Extract<CompileResult, { success: true }>
> => {
  webFrameworkFixtureCompile ??= createSdk().compile({
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
};

type HookResponse = {
  requestId: number;
  status: number;
  body: Uint8Array;
};

const createHttpServerHarness = (): {
  enqueueRequest: (requestId: number, requestPath: string) => void;
  responses: HookResponse[];
  runtimeHooks: DefaultAdapterRuntimeHooks;
} => {
  const queuedRequests: HookRequest[] = [];
  const acceptWaiters: Array<(request: HookRequest) => void> = [];
  const responses: HookResponse[] = [];
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

  return {
    enqueueRequest,
    responses,
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
      httpServerRespond: async (response) => {
        responses.push(response);
      },
      httpServerClose: async () => undefined,
    },
  };
};

describe("integration: pkg::web", () => {
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

    const mapperId = await host.run<number>("durable_message_mapper_probe");
    expect(host.retainedCallbacks.size()).toBe(1);
    await expect(host.retainedCallbacks.dispatch(mapperId, 41)).resolves.toBe(
      42,
    );
    host.retainedCallbacks.release(mapperId);

    const explicitHandlerId = await host.run<number>(
      "explicit_event_id_survives_ssr_probe",
    );
    expect(host.retainedCallbacks.size()).toBe(1);
    await expect(
      host.retainedCallbacks.dispatch(explicitHandlerId, undefined),
    ).resolves.toBe(42);
    host.retainedCallbacks.release(explicitHandlerId);

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
    const sdk = createSdk();
    const result = expectCompileSuccess(
      await sdk.compile({
        source: `
use pkg::web::{
  Body,
  Context,
  Headers,
  IncomingRequest,
  Method,
  Response,
  build_app,
  route_params_context
}
use std::optional::types::all
use std::result::types::all
use std::string::type::String

type UserParams = {
  id: String
}

fn request(method: Method, path: String) -> IncomingRequest
  IncomingRequest {
    method: method,
    path: path,
    query: None {},
    headers: Headers::empty(),
    body: Body::empty()
  }

fn response_text(response: Response) -> String
  match(response.text())
    Ok<String> { value }:
      value
    Err:
      "error".as_slice().to_string()

pub fn route_option_response_probe() -> i32
  let built = build_app do(base):
    route_params_context(base, "/option/:id".as_slice(), method: Method::Get {}) do(params: UserParams, _ctx: Context):
      let value: Option<String> = Some<String> { value: params.id }
      value

  let response = built.handle(request(Method::Get {}, "/option/ada".as_slice().to_string()))
  if response.status.code() != 200:
    return response.status.code()
  if not response_text(response).equals("ada".as_slice().to_string()):
    return -12

  response.status.code()
`,
        roots: {
          src: fixtureRoot,
          pkgDirs: [path.join(repoRoot, "packages")],
        },
      }),
    );

    await expect(
      result.run<number>({ entryName: "route_option_response_probe" }),
    ).resolves.toBe(200);
  });

  it("supports body and auth policies on method helpers", async () => {
    const sdk = createSdk();
    const result = expectCompileSuccess(
      await sdk.compile({
        source: `
use pkg::web::{
  Body,
  Context,
  Headers,
  IncomingRequest,
  Method,
  Response,
  build_app,
  delete,
  json_body,
  patch,
  put,
  required_session,
  route,
  text_body
}
use std::optional::types::all
use std::result::types::all
use std::string::type::String

type CreateUser = {
  name: String,
  active: bool
}

fn request_with_body(method: Method, path: String, body: Body) -> IncomingRequest
  IncomingRequest {
    method: method,
    path: path,
    query: None {},
    headers: Headers::empty(),
    body: body
  }

fn response_text(response: Response) -> String
  match(response.text())
    Ok<String> { value }:
      value
    Err:
      "error".as_slice().to_string()

fn replace_user(input: CreateUser) -> Response
  let active = if input.active then: "active".as_slice().to_string() else: "inactive".as_slice().to_string()
  Response::ok().text(input.name.concat(":".as_slice()).concat(active))

fn patch_session(input: String, session: String) -> Response
  Response::ok().text(session.concat(":".as_slice()).concat(input))

fn delete_body(input: String) -> Response
  Response::ok().text(input)

fn manual_body(input: CreateUser) -> Response
  Response::ok().text(input.name.concat(":manual".as_slice()))

pub fn method_body_route_probe() -> i32
  let built = build_app do(base):
    let with_put = put(base, "/replace".as_slice(), body: json_body(), replace_user)
    let with_patch = patch(with_put, "/session-patch".as_slice(), body: text_body(), auth: required_session(), patch_session)
    let with_delete = delete(with_patch, "/remove".as_slice(), body: text_body(), delete_body)
    route(with_delete, "/manual".as_slice(), method: Method::Put {}, body: json_body(), manual_body)

  let put_response = built.handle(
    request_with_body(
      Method::Put {},
      "/replace".as_slice().to_string(),
      Body::text("{\\"name\\":\\"Ada\\",\\"active\\":true}".as_slice())
    )
  )
  if not response_text(put_response).equals("Ada:active"):
    return -20

  let patch_response = built.handle(
    IncomingRequest {
      method: Method::Patch {},
      path: "/session-patch".as_slice().to_string(),
      query: None {},
      headers: Headers::empty().append(header: "authorization".as_slice(), value: "grace".as_slice()),
      body: Body::text("hello".as_slice())
    }
  )
  if not response_text(patch_response).equals("grace:hello"):
    return -21

  let delete_response = built.handle(
    request_with_body(
      Method::Delete {},
      "/remove".as_slice().to_string(),
      Body::text("bye".as_slice())
    )
  )
  if not response_text(delete_response).equals("bye"):
    return -22

  let manual_response = built.handle(
    request_with_body(
      Method::Put {},
      "/manual".as_slice().to_string(),
      Body::text("{\\"name\\":\\"Manual\\",\\"active\\":false}".as_slice())
    )
  )
  if not response_text(manual_response).equals("Manual:manual"):
    return -23

  manual_response.status.code()
`,
        roots: {
          src: fixtureRoot,
          pkgDirs: [path.join(repoRoot, "packages")],
        },
      }),
    );

    await expect(
      result.run<number>({ entryName: "method_body_route_probe" }),
    ).resolves.toBe(200);
  });

  it("cancels route handlers that exceed timeout policies", async () => {
    const sdk = createSdk();
    const result = expectCompileSuccess(
      await sdk.compile({
        source: `
use pkg::web::{
  Body,
  Context,
  Headers,
  IncomingRequest,
  Method,
  Response,
  app,
  route_context,
  timeout_millis
}
use std::number::cast::self as cast
use std::optional::types::all
use std::string::type::String
use std::task::self as task
use std::time::self as time
use std::time::{ Duration, Time }

fn request(method: Method, path: String) -> IncomingRequest
  IncomingRequest {
    method: method,
    path: path,
    query: None {},
    headers: Headers::empty(),
    body: Body::empty()
  }

fn response_text(response: Response) -> String
  match(response.text())
    Ok<String> { value }:
      value
    Err:
      "error".as_slice().to_string()

pub fn timeout_route_probe(): (task::TaskRuntime, Time) -> i32
  let built = route_context(
    app(),
    "/slow".as_slice(),
    method: Method::Get {},
    timeout: timeout_millis(1)
  ) do(_ctx: Context):
    let _ = time::sleep(Duration::from_millis(cast::to_i64(20)))
    Response::ok().text("slow".as_slice())

  let response = built.handle(request(Method::Get {}, "/slow".as_slice().to_string()))
  if response.status.code() != 504:
    return response.status.code()
  if not response_text(response).equals("route timed out"):
    return -40
  response.status.code()
`,
        roots: {
          src: fixtureRoot,
          pkgDirs: [path.join(repoRoot, "packages")],
        },
      }),
    );

    await expect(
      result.run<number>({
        entryName: "timeout_route_probe",
        defaultAdapters: true,
      }),
    ).resolves.toBe(504);
  });

  it("converts responses from free get helpers", async () => {
    const sdk = createSdk();
    const result = expectCompileSuccess(
      await sdk.compile({
        source: `
use pkg::web::{
  Body,
  Context,
  Headers,
  IncomingRequest,
  Method,
  Response,
  build_app,
  get,
  get_context
}
use std::json::{ JsonBool, JsonValue }
use std::optional::types::all
use std::result::types::all
use std::string::type::String

type UserParams = {
  id: String
}

fn request(method: Method, path: String) -> IncomingRequest
  IncomingRequest {
    method: method,
    path: path,
    query: None {},
    headers: Headers::empty(),
    body: Body::empty()
  }

fn response_text(response: Response) -> String
  match(response.text())
    Ok<String> { value }:
      value
    Err:
      "error".as_slice().to_string()

fn json_from_context(_ctx: Context) -> JsonValue
  let value: JsonValue = JsonBool { value: true }
  value

fn optional_user(params: UserParams) -> Option<String>
  Some<String> { value: params.id }

pub fn free_get_response_probe() -> i32
  let built = build_app do(base):
    let with_json = get_context(base, "/json".as_slice(), json_from_context)
    get(with_json, "/users/:id".as_slice(), optional_user)

  let json_response = built.handle(request(Method::Get {}, "/json".as_slice().to_string()))
  if json_response.status.code() != 200:
    return -30
  let content_type = json_response.header("content-type".as_slice()) ?? "missing".as_slice().to_string()
  if not content_type.equals("application/json"):
    return -31

  let user_response = built.handle(request(Method::Get {}, "/users/ada".as_slice().to_string()))
  if user_response.status.code() != 200:
    return -32
  if not response_text(user_response).equals("ada"):
    return -33

  user_response.status.code()
`,
        roots: {
          src: fixtureRoot,
          pkgDirs: [path.join(repoRoot, "packages")],
        },
      }),
    );

    await expect(
      result.run<number>({ entryName: "free_get_response_probe" }),
    ).resolves.toBe(200);
  });

  it("exports the documented router submodule", async () => {
    const sdk = createSdk();
    const result = expectCompileSuccess(
      await sdk.compile({
        source: `
use pkg::web::router
use pkg::web::{ Body, Headers, IncomingRequest, Method, Response }
use std::optional::types::all
use std::string::type::String

fn request(method: Method, path: String) -> IncomingRequest
  IncomingRequest {
    method: method,
    path: path,
    query: None {},
    headers: Headers::empty(),
    body: Body::empty()
  }

pub fn router_module_export_probe() -> i32
  let built = router::app()
    .get("/health".as_slice(), handler: (_ctx: router::Context) -> Response =>
      Response::ok().text("ok".as_slice())
    )
  let response = built.handle(request(Method::Get {}, "/health".as_slice().to_string()))
  response.status.code()
`,
        roots: {
          src: fixtureRoot,
          pkgDirs: [path.join(repoRoot, "packages")],
        },
      }),
    );

    await expect(
      result.run<number>({ entryName: "router_module_export_probe" }),
    ).resolves.toBe(200);
  });

  it("rejects unknown route DSL extractor parameter names", async () => {
    const sdk = createSdk();
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
});
