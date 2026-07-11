import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSdk, type CompileResult } from "@voyd-lang/sdk";

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

describe("integration: pkg::web", () => {
  it("routes requests and builds apps through the public package API", async () => {
    const sdk = createSdk();
    const entryPath = path.join(fixtureRoot, "web-framework.voyd");
    const result = expectCompileSuccess(
      await sdk.compile({
        entryPath,
        roots: {
          src: fixtureRoot,
          pkgDirs: [path.join(repoRoot, "packages")],
        },
      }),
    );

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
