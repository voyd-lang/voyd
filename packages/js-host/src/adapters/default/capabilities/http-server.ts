import {
  globalRecord,
  hostError,
  hostOk,
  httpServerAcceptSuccessPayload,
  isRecord,
  readField,
  toNumberOrUndefined,
  toStringOrUndefined,
} from "../helpers.js";
import {
  opEntries,
  registerMissingOpHandlers,
  registerOpHandler,
  registerUnsupportedHandlers,
} from "../registration.js";
import {
  maybeNodeHttp,
  type NodeHttpIncomingMessage,
  type NodeHttpServer,
  type NodeHttpServerResponse,
} from "../runtime-imports.js";
import {
  HTTP_SERVER_EFFECT_ID,
  type CapabilityDefinition,
  type DefaultAdapterHttpHeader,
  type DefaultAdapterHttpRequest,
  type DefaultAdapterHttpResponse,
  type DefaultAdapterHttpServerConfig,
} from "../types.js";

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_PENDING_REQUESTS = 100;
const DEFAULT_RESPONSE_TIMEOUT_MILLIS = 30_000;
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

type PendingNodeResponse = {
  response: NodeHttpServerResponse;
  completed: boolean;
  timeoutHandle?: ReturnType<typeof setTimeout>;
};

type NodeServerState = {
  server: NodeHttpServer;
  queue: DefaultAdapterHttpRequest[];
  waiters: Array<{
    resolve: (request: DefaultAdapterHttpRequest) => void;
    reject: (error: Error) => void;
  }>;
  pendingResponses: Map<number, PendingNodeResponse>;
  closed: boolean;
  maxBodyBytes: number;
  maxPendingRequests: number;
  responseTimeoutMillis: number;
};

type RequestQueueState = {
  queue: DefaultAdapterHttpRequest[];
  waiters: Array<{
    resolve: (request: DefaultAdapterHttpRequest) => void;
    reject: (error: Error) => void;
  }>;
  maxPendingRequests: number;
};

type WebPendingResponse = {
  resolve: (response: unknown) => void;
  completed: boolean;
  timeoutHandle?: ReturnType<typeof setTimeout>;
};

type WebServerState = RequestQueueState & {
  closeRuntime: () => Promise<void>;
  pendingResponses: Map<number, WebPendingResponse>;
  closed: boolean;
  maxBodyBytes: number;
  responseTimeoutMillis: number;
};

type WebServerHandle = {
  close: () => Promise<void>;
};

type WebServerHandler = (request: unknown) => Promise<unknown>;

type HttpServerSource = {
  isAvailable: boolean;
  unavailableReason: string;
  listen: (config: DefaultAdapterHttpServerConfig) => Promise<number>;
  accept: (serverId: number) => Promise<DefaultAdapterHttpRequest>;
  respond: (response: DefaultAdapterHttpResponse) => Promise<void>;
  close: (serverId: number) => Promise<void>;
};

const toByteArray = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (Array.isArray(value)) {
    return Uint8Array.from(
      value.map((entry) => {
        const parsed = toNumberOrUndefined(entry);
        if (parsed === undefined) {
          return 0;
        }
        return ((Math.trunc(parsed) % 256) + 256) % 256;
      })
    );
  }
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  return new Uint8Array();
};

const decodeHeaders = (value: unknown): DefaultAdapterHttpHeader[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.reduce<DefaultAdapterHttpHeader[]>((headers, entry) => {
    const name = toStringOrUndefined(readField(entry, "name"))?.trim();
    if (!name) {
      return headers;
    }
    headers.push({
      name,
      value:
        toStringOrUndefined(readField(entry, "value")) ??
        String(readField(entry, "value") ?? ""),
    });
    return headers;
  }, []);
};

const headersFromWebHeaders = (value: unknown): DefaultAdapterHttpHeader[] => {
  if (!isRecord(value)) {
    return [];
  }

  const entries = readField(value, "entries");
  if (typeof entries === "function") {
    return Array.from((entries as () => Iterable<unknown>).call(value)).flatMap(
      (entry) => {
        if (!Array.isArray(entry)) {
          return [];
        }
        const [nameValue, headerValue] = entry;
        const name = toStringOrUndefined(nameValue)?.trim();
        if (!name) {
          return [];
        }
        return [
          {
            name,
            value: toStringOrUndefined(headerValue) ?? String(headerValue ?? ""),
          },
        ];
      }
    );
  }

  const forEach = readField(value, "forEach");
  if (typeof forEach === "function") {
    const headers: DefaultAdapterHttpHeader[] = [];
    (
      forEach as (
        callback: (headerValue: unknown, nameValue: unknown) => void
      ) => void
    ).call(value, (headerValue, nameValue) => {
      const name = toStringOrUndefined(nameValue)?.trim();
      if (!name) {
        return;
      }
      headers.push({
        name,
        value: toStringOrUndefined(headerValue) ?? String(headerValue ?? ""),
      });
    });
    return headers;
  }

  return [];
};

const decodeConfig = (payload: unknown): DefaultAdapterHttpServerConfig => {
  const port = toNumberOrUndefined(readField(payload, "port"));
  if (port === undefined) {
    throw new Error("http server listen payload must include port");
  }
  const maxBodyBytes = toNumberOrUndefined(readField(payload, "max_body_bytes"));
  const maxPendingRequests = toNumberOrUndefined(
    readField(payload, "max_pending_requests")
  );
  const responseTimeoutMillis = toNumberOrUndefined(
    readField(payload, "response_timeout_millis") ??
      readField(payload, "responseTimeoutMillis")
  );
  return {
    port: Math.trunc(port),
    host: toStringOrUndefined(readField(payload, "host")) || undefined,
    maxBodyBytes:
      maxBodyBytes === undefined ? undefined : Math.max(0, Math.trunc(maxBodyBytes)),
    maxPendingRequests:
      maxPendingRequests === undefined
        ? undefined
        : Math.max(0, Math.trunc(maxPendingRequests)),
    responseTimeoutMillis:
      responseTimeoutMillis === undefined
        ? undefined
        : Math.max(1, Math.trunc(responseTimeoutMillis)),
  };
};

const decodeResponsePayload = (payload: unknown): DefaultAdapterHttpResponse => {
  const requestId = toNumberOrUndefined(readField(payload, "request_id"));
  if (requestId === undefined) {
    throw new Error("http server response payload must include request_id");
  }
  const response = readField(payload, "response");
  const status = toNumberOrUndefined(readField(response, "status"));
  if (status === undefined) {
    throw new Error("http server response payload must include response.status");
  }
  return {
    requestId: Math.trunc(requestId),
    status: Math.trunc(status),
    reason:
      toStringOrUndefined(readField(response, "reason")) ??
      toStringOrUndefined(readField(response, "status_text")) ??
      "",
    headers: decodeHeaders(readField(response, "headers")),
    body: toByteArray(readField(response, "body")),
  };
};

const headersFromNodeRequest = (
  request: NodeHttpIncomingMessage
): DefaultAdapterHttpHeader[] => {
  const rawHeaders = request.rawHeaders;
  if (Array.isArray(rawHeaders) && rawHeaders.length > 0) {
    const headers: DefaultAdapterHttpHeader[] = [];
    for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
      headers.push({ name: rawHeaders[index] ?? "", value: rawHeaders[index + 1] ?? "" });
    }
    return headers.filter((header) => header.name.length > 0);
  }

  return Object.entries(request.headers).flatMap(([name, value]) => {
    if (Array.isArray(value)) {
      return value.map((entry) => ({ name, value: entry }));
    }
    if (value === undefined) {
      return [];
    }
    return [{ name, value }];
  });
};

const readRequestBody = async ({
  request,
  maxBodyBytes,
}: {
  request: NodeHttpIncomingMessage;
  maxBodyBytes: number;
}): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes =
      typeof chunk === "string" ? new TextEncoder().encode(chunk) : toByteArray(chunk);
    total += bytes.byteLength;
    if (total > maxBodyBytes) {
      throw new Error(`request body exceeds max_body_bytes (${maxBodyBytes})`);
    }
    chunks.push(bytes);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

const enqueueRequest = ({
  state,
  request,
}: {
  state: RequestQueueState;
  request: DefaultAdapterHttpRequest;
}): boolean => {
  const waiter = state.waiters.shift();
  if (waiter) {
    waiter.resolve(request);
    return true;
  }
  if (state.queue.length >= state.maxPendingRequests) {
    return false;
  }
  state.queue.push(request);
  return true;
};

const webResponse = ({
  status,
  reason = "",
  headers = [],
  body,
}: {
  status: number;
  reason?: string;
  headers?: DefaultAdapterHttpHeader[];
  body: string | Uint8Array;
}): unknown => {
  const ResponseCtor = globalRecord.Response as
    | (new (
        body?: string | Uint8Array,
        init?: {
          status?: number;
          statusText?: string;
          headers?: Array<[string, string]>;
        }
      ) => unknown)
    | undefined;
  if (typeof ResponseCtor !== "function") {
    throw new Error("http server runtime requires Response support");
  }
  return new ResponseCtor(NULL_BODY_STATUSES.has(status) ? undefined : body, {
    status,
    statusText: reason,
    headers: headers.map((header) => [header.name, header.value]),
  });
};

const writeNodeResponse = ({
  target,
  response,
}: {
  target: NodeHttpServerResponse;
  response: DefaultAdapterHttpResponse;
}): Promise<void> =>
  new Promise((resolve, reject) => {
    if (target.destroyed || target.writableEnded) {
      reject(new Error("client disconnected before response"));
      return;
    }

    const headers = new Map<string, string[]>();
    for (const header of response.headers) {
      const existing = headers.get(header.name) ?? [];
      existing.push(header.value);
      headers.set(header.name, existing);
    }
    for (const [name, values] of headers) {
      target.setHeader(name, values.length === 1 ? values[0] ?? "" : values);
    }

    target.statusCode = response.status;
    target.statusMessage = response.reason;
    target.once("error", reject);
    target.end(response.body, () => {
      target.off("error", reject);
      resolve();
    });
  });

const completePendingNodeResponse = ({
  state,
  requestId,
  status,
  body,
}: {
  state: NodeServerState;
  requestId: number;
  status: number;
  body: string;
}): void => {
  const pending = state.pendingResponses.get(requestId);
  if (!pending || pending.completed) {
    return;
  }
  pending.completed = true;
  if (pending.timeoutHandle !== undefined) {
    clearTimeout(pending.timeoutHandle);
  }
  state.pendingResponses.delete(requestId);
  state.queue = state.queue.filter((request) => request.requestId !== requestId);
  if (!pending.response.destroyed && !pending.response.writableEnded) {
    pending.response.statusCode = status;
    pending.response.end(body);
  }
};

const addPendingNodeResponse = ({
  state,
  requestId,
  response,
}: {
  state: NodeServerState;
  requestId: number;
  response: NodeHttpServerResponse;
}): void => {
  const pending: PendingNodeResponse = { response, completed: false };
  pending.timeoutHandle = setTimeout(() => {
    completePendingNodeResponse({
      state,
      requestId,
      status: 500,
      body: "server response timeout",
    });
  }, state.responseTimeoutMillis);
  state.pendingResponses.set(requestId, pending);
};

const releasePendingNodeResponses = ({
  state,
  serverId,
}: {
  state: NodeServerState;
  serverId: number;
}): void => {
  for (const waiter of state.waiters.splice(0)) {
    waiter.reject(new Error(`http server ${serverId} closed`));
  }
  for (const pending of state.pendingResponses.values()) {
    if (pending.timeoutHandle !== undefined) {
      clearTimeout(pending.timeoutHandle);
    }
    if (
      !pending.completed &&
      !pending.response.destroyed &&
      !pending.response.writableEnded
    ) {
      pending.completed = true;
      pending.response.statusCode = 500;
      pending.response.end("server closed before response");
    }
  }
  state.pendingResponses.clear();
  state.queue = [];
};

const readWebRequestBody = async ({
  request,
  maxBodyBytes,
}: {
  request: unknown;
  maxBodyBytes: number;
}): Promise<Uint8Array> => {
  const arrayBuffer = readField(request, "arrayBuffer");
  if (typeof arrayBuffer === "function") {
    const body = toByteArray(await (arrayBuffer as () => Promise<unknown>).call(request));
    if (body.byteLength > maxBodyBytes) {
      throw new Error(`request body exceeds max_body_bytes (${maxBodyBytes})`);
    }
    return body;
  }

  const text = readField(request, "text");
  if (typeof text === "function") {
    const body = toByteArray(await (text as () => Promise<unknown>).call(request));
    if (body.byteLength > maxBodyBytes) {
      throw new Error(`request body exceeds max_body_bytes (${maxBodyBytes})`);
    }
    return body;
  }

  const body = toByteArray(readField(request, "body"));
  if (body.byteLength > maxBodyBytes) {
    throw new Error(`request body exceeds max_body_bytes (${maxBodyBytes})`);
  }
  return body;
};

const completeWebPendingResponse = ({
  state,
  requestId,
  response,
}: {
  state: WebServerState;
  requestId: number;
  response: unknown;
}): void => {
  const pending = state.pendingResponses.get(requestId);
  if (!pending || pending.completed) {
    return;
  }
  pending.completed = true;
  if (pending.timeoutHandle !== undefined) {
    clearTimeout(pending.timeoutHandle);
  }
  state.pendingResponses.delete(requestId);
  state.queue = state.queue.filter((request) => request.requestId !== requestId);
  pending.resolve(response);
};

const addWebPendingResponse = ({
  state,
  requestId,
  resolve,
}: {
  state: WebServerState;
  requestId: number;
  resolve: (response: unknown) => void;
}): void => {
  const pending: WebPendingResponse = { resolve, completed: false };
  pending.timeoutHandle = setTimeout(() => {
    completeWebPendingResponse({
      state,
      requestId,
      response: webResponse({
        status: 500,
        body: "server response timeout",
      }),
    });
  }, state.responseTimeoutMillis);
  state.pendingResponses.set(requestId, pending);
};

const releasePendingWebResponses = ({
  state,
  serverId,
}: {
  state: WebServerState;
  serverId: number;
}): void => {
  for (const waiter of state.waiters.splice(0)) {
    waiter.reject(new Error(`http server ${serverId} closed`));
  }
  for (const [requestId] of state.pendingResponses) {
    completeWebPendingResponse({
      state,
      requestId,
      response: webResponse({
        status: 500,
        body: "server closed before response",
      }),
    });
  }
  state.pendingResponses.clear();
  state.queue = [];
};

const responseFromDefaultAdapterResponse = (
  response: DefaultAdapterHttpResponse
): unknown =>
  webResponse({
    status: response.status,
    reason: response.reason,
    headers: response.headers,
    body: response.body,
  });

const createNodeHttpServerSource = async (): Promise<HttpServerSource> => {
  const nodeHttp = await maybeNodeHttp();
  if (!nodeHttp) {
    return {
      isAvailable: false,
      unavailableReason: "Node HTTP module is unavailable",
      listen: async () => {
        throw new Error("Node HTTP module is unavailable");
      },
      accept: async () => {
        throw new Error("Node HTTP module is unavailable");
      },
      respond: async () => {
        throw new Error("Node HTTP module is unavailable");
      },
      close: async () => {
        throw new Error("Node HTTP module is unavailable");
      },
    };
  }
  const servers = new Map<number, NodeServerState>();
  let nextServerId = 1;
  let nextRequestId = 1;

  const serverFor = (serverId: number): NodeServerState => {
    const state = servers.get(serverId);
    if (!state || state.closed) {
      throw new Error(`http server ${serverId} is closed or unknown`);
    }
    return state;
  };

  return {
    isAvailable: true,
    unavailableReason: "",
    listen: async (config) => {
      const serverId = nextServerId++;
      const state: NodeServerState = {
        server: undefined as unknown as NodeHttpServer,
        queue: [],
        waiters: [],
        pendingResponses: new Map(),
        closed: false,
        maxBodyBytes: config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
        maxPendingRequests:
          config.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS,
        responseTimeoutMillis:
          config.responseTimeoutMillis ?? DEFAULT_RESPONSE_TIMEOUT_MILLIS,
      };

      const server = nodeHttp.createServer(async (request, response) => {
        try {
          if (
            state.pendingResponses.size >= state.maxPendingRequests
          ) {
            response.statusCode = 503;
            response.end("server pending request limit reached");
            return;
          }

          const body = await readRequestBody({
            request,
            maxBodyBytes: state.maxBodyBytes,
          });
          const requestId = nextRequestId++;
          const url = new URL(request.url ?? "/", "http://localhost");
          addPendingNodeResponse({ state, requestId, response });
          const queued = enqueueRequest({
            state,
            request: {
              requestId,
              method: request.method ?? "GET",
              path: url.pathname || "/",
              query: url.search.length > 1 ? url.search.slice(1) : undefined,
              headers: headersFromNodeRequest(request),
              body,
            },
          });
          if (!queued) {
            completePendingNodeResponse({
              state,
              requestId,
              status: 503,
              body: "server pending request limit reached",
            });
          }
        } catch (error) {
          response.statusCode =
            error instanceof Error && error.message.includes("max_body_bytes")
              ? 413
              : 500;
          response.end(error instanceof Error ? error.message : String(error));
        }
      });

      state.server = server;
      servers.set(serverId, state);

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host ?? "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });

      server.once("close", () => {
        state.closed = true;
        releasePendingNodeResponses({ state, serverId });
        servers.delete(serverId);
      });

      return serverId;
    },
    accept: async (serverId) => {
      const state = serverFor(serverId);
      const queued = state.queue.shift();
      if (queued) {
        return queued;
      }
      return new Promise<DefaultAdapterHttpRequest>((resolve, reject) => {
        state.waiters.push({ resolve, reject });
      });
    },
    respond: async (response) => {
      for (const state of servers.values()) {
        const pending = state.pendingResponses.get(response.requestId);
        if (!pending) {
          continue;
        }
        if (pending.completed) {
          throw new Error(`request ${response.requestId} was already responded to`);
        }
        pending.completed = true;
        if (pending.timeoutHandle !== undefined) {
          clearTimeout(pending.timeoutHandle);
        }
        state.pendingResponses.delete(response.requestId);
        await writeNodeResponse({ target: pending.response, response });
        return;
      }
      throw new Error(`request ${response.requestId} is closed or unknown`);
    },
    close: async (serverId) => {
      const state = servers.get(serverId);
      if (!state || state.closed) {
        return;
      }
      state.closed = true;
      releasePendingNodeResponses({ state, serverId });
      await new Promise<void>((resolve, reject) => {
        state.server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
};

const createWebHttpServerSource = ({
  unavailableReason,
  listenRuntime,
}: {
  unavailableReason: string;
  listenRuntime?: (
    config: DefaultAdapterHttpServerConfig,
    handler: WebServerHandler
  ) => Promise<WebServerHandle> | WebServerHandle;
}): HttpServerSource => {
  if (!listenRuntime) {
    return {
      isAvailable: false,
      unavailableReason,
      listen: async () => {
        throw new Error(unavailableReason);
      },
      accept: async () => {
        throw new Error(unavailableReason);
      },
      respond: async () => {
        throw new Error(unavailableReason);
      },
      close: async () => {
        throw new Error(unavailableReason);
      },
    };
  }

  const servers = new Map<number, WebServerState>();
  let nextServerId = 1;
  let nextRequestId = 1;

  const serverFor = (serverId: number): WebServerState => {
    const state = servers.get(serverId);
    if (!state || state.closed) {
      throw new Error(`http server ${serverId} is closed or unknown`);
    }
    return state;
  };

  return {
    isAvailable: true,
    unavailableReason: "",
    listen: async (config) => {
      const serverId = nextServerId++;
      const state: WebServerState = {
        closeRuntime: async () => {},
        queue: [],
        waiters: [],
        pendingResponses: new Map(),
        closed: false,
        maxBodyBytes: config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
        maxPendingRequests:
          config.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS,
        responseTimeoutMillis:
          config.responseTimeoutMillis ?? DEFAULT_RESPONSE_TIMEOUT_MILLIS,
      };

      const handler: WebServerHandler = async (request) => {
        try {
          if (
            state.closed ||
            state.pendingResponses.size >= state.maxPendingRequests
          ) {
            return webResponse({
              status: state.closed ? 503 : 503,
              body: state.closed
                ? "server closed before response"
                : "server pending request limit reached",
            });
          }

          const body = await readWebRequestBody({
            request,
            maxBodyBytes: state.maxBodyBytes,
          });
          const requestId = nextRequestId++;
          const rawUrl = toStringOrUndefined(readField(request, "url")) ?? "/";
          const url = new URL(rawUrl, "http://localhost");
          const responsePromise = new Promise<unknown>((resolve) => {
            addWebPendingResponse({ state, requestId, resolve });
          });
          const queued = enqueueRequest({
            state,
            request: {
              requestId,
              method:
                toStringOrUndefined(readField(request, "method")) ?? "GET",
              path: url.pathname || "/",
              query: url.search.length > 1 ? url.search.slice(1) : undefined,
              headers: headersFromWebHeaders(readField(request, "headers")),
              body,
            },
          });
          if (!queued) {
            completeWebPendingResponse({
              state,
              requestId,
              response: webResponse({
                status: 503,
                body: "server pending request limit reached",
              }),
            });
          }
          return responsePromise;
        } catch (error) {
          return webResponse({
            status:
              error instanceof Error && error.message.includes("max_body_bytes")
                ? 413
                : 500,
            body: error instanceof Error ? error.message : String(error),
          });
        }
      };

      const runtimeServer = await listenRuntime(config, handler);
      state.closeRuntime = runtimeServer.close;
      servers.set(serverId, state);
      return serverId;
    },
    accept: async (serverId) => {
      const state = serverFor(serverId);
      const queued = state.queue.shift();
      if (queued) {
        return queued;
      }
      return new Promise<DefaultAdapterHttpRequest>((resolve, reject) => {
        state.waiters.push({ resolve, reject });
      });
    },
    respond: async (response) => {
      for (const state of servers.values()) {
        const pending = state.pendingResponses.get(response.requestId);
        if (!pending) {
          continue;
        }
        if (pending.completed) {
          throw new Error(`request ${response.requestId} was already responded to`);
        }
        completeWebPendingResponse({
          state,
          requestId: response.requestId,
          response: responseFromDefaultAdapterResponse(response),
        });
        return;
      }
      throw new Error(`request ${response.requestId} is closed or unknown`);
    },
    close: async (serverId) => {
      const state = servers.get(serverId);
      if (!state || state.closed) {
        return;
      }
      state.closed = true;
      releasePendingWebResponses({ state, serverId });
      await state.closeRuntime();
      servers.delete(serverId);
    },
  };
};

const createDenoHttpServerSource = (): HttpServerSource => {
  const deno = globalRecord.Deno as
    | {
        serve?: (
          options: Record<string, unknown>,
          handler: WebServerHandler
        ) => unknown;
      }
    | undefined;
  if (typeof deno?.serve !== "function") {
    return createWebHttpServerSource({
      unavailableReason: "Deno.serve is unavailable",
    });
  }

  return createWebHttpServerSource({
    unavailableReason: "",
    listenRuntime: async (config, handler) => {
      const runtimeServer = deno.serve!(
        {
          port: config.port,
          hostname: config.host ?? "127.0.0.1",
        },
        handler
      );
      return {
        close: async () => {
          const shutdown = readField(runtimeServer, "shutdown");
          if (typeof shutdown === "function") {
            await (shutdown as () => Promise<void> | void).call(runtimeServer);
            return;
          }
          const stop = readField(runtimeServer, "stop");
          if (typeof stop === "function") {
            await (stop as () => Promise<void> | void).call(runtimeServer);
          }
        },
      };
    },
  });
};

const createBunHttpServerSource = (): HttpServerSource => {
  const bun = globalRecord.Bun as
    | {
        serve?: (options: Record<string, unknown>) => unknown;
      }
    | undefined;
  if (typeof bun?.serve !== "function") {
    return createWebHttpServerSource({
      unavailableReason: "Bun.serve is unavailable",
    });
  }

  return createWebHttpServerSource({
    unavailableReason: "",
    listenRuntime: async (config, handler) => {
      const runtimeServer = bun.serve!({
        port: config.port,
        hostname: config.host ?? "127.0.0.1",
        fetch: handler,
      });
      return {
        close: async () => {
          const stop = readField(runtimeServer, "stop");
          if (typeof stop === "function") {
            await (stop as (force?: boolean) => Promise<void> | void).call(
              runtimeServer,
              true
            );
          }
        },
      };
    },
  });
};

const createHookHttpServerSource = ({
  listen,
  accept,
  respond,
  close,
}: {
  listen?: (config: DefaultAdapterHttpServerConfig) => Promise<number>;
  accept?: (serverId: number) => Promise<DefaultAdapterHttpRequest>;
  respond?: (response: DefaultAdapterHttpResponse) => Promise<void>;
  close?: (serverId: number) => Promise<void>;
}): HttpServerSource | undefined => {
  if (listen && accept && respond && close) {
    return {
      isAvailable: true,
      unavailableReason: "",
      listen,
      accept,
      respond,
      close,
    };
  }
  return undefined;
};

const createHttpServerSource = async ({
  runtime,
  hooks,
}: {
  runtime: string;
  hooks: {
    listen?: (config: DefaultAdapterHttpServerConfig) => Promise<number>;
    accept?: (serverId: number) => Promise<DefaultAdapterHttpRequest>;
    respond?: (response: DefaultAdapterHttpResponse) => Promise<void>;
    close?: (serverId: number) => Promise<void>;
  };
}): Promise<HttpServerSource> => {
  const hookSource = createHookHttpServerSource(hooks);
  if (hookSource) {
    return hookSource;
  }

  if (runtime === "node") {
    return createNodeHttpServerSource();
  }
  if (runtime === "deno") {
    return createDenoHttpServerSource();
  }
  if (runtime === "bun") {
    return createBunHttpServerSource();
  }

  const unavailableReason =
    runtime === "browser"
      ? "browser runtimes cannot listen for inbound HTTP requests"
      : "http server requires node runtime or explicit runtimeHooks";
  return {
    isAvailable: false,
    unavailableReason,
    listen: async () => {
      throw new Error(unavailableReason);
    },
    accept: async () => {
      throw new Error(unavailableReason);
    },
    respond: async () => {
      throw new Error(unavailableReason);
    },
    close: async () => {
      throw new Error(unavailableReason);
    },
  };
};

export const httpServerCapabilityDefinition: CapabilityDefinition = {
  capability: "http-server",
  effectId: HTTP_SERVER_EFFECT_ID,
  register: async ({
    host,
    runtime,
    diagnostics,
    runtimeHooks,
    effectBufferSize,
  }) => {
    const entries = opEntries({ host, effectId: HTTP_SERVER_EFFECT_ID });
    if (entries.length === 0) {
      return 0;
    }

    const httpServerSource = await createHttpServerSource({
      runtime,
      hooks: {
        listen: runtimeHooks.httpServerListen,
        accept: runtimeHooks.httpServerAccept,
        respond: runtimeHooks.httpServerRespond,
        close: runtimeHooks.httpServerClose,
      },
    });
    if (!httpServerSource.isAvailable) {
      return registerUnsupportedHandlers({
        host,
        effectId: HTTP_SERVER_EFFECT_ID,
        capability: "http-server",
        runtime,
        reason: httpServerSource.unavailableReason,
        diagnostics,
      });
    }

    const implementedOps = new Set<string>();
    let registered = 0;
    registered += registerOpHandler({
      host,
      effectId: HTTP_SERVER_EFFECT_ID,
      opName: "listen_raw",
      handler: async ({ tail, registerResourceCleanup }, payload) => {
        try {
          const serverId = await httpServerSource.listen(decodeConfig(payload));
          registerResourceCleanup?.(() => httpServerSource.close(serverId));
          return tail(hostOk(serverId));
        } catch (error) {
          return tail(hostError(error instanceof Error ? error.message : String(error)));
        }
      },
    });
    implementedOps.add("listen_raw");

    registered += registerOpHandler({
      host,
      effectId: HTTP_SERVER_EFFECT_ID,
      opName: "accept_raw",
      handler: async ({ resume }, serverId) => {
        try {
          const parsedServerId = toNumberOrUndefined(serverId);
          if (parsedServerId === undefined) {
            throw new Error("http server accept requires a server id");
          }
          const request = await httpServerSource.accept(Math.trunc(parsedServerId));
          const payload = httpServerAcceptSuccessPayload({
            request,
            effectBufferSize,
          });
          if (readField(payload, "ok") === false) {
            await httpServerSource.respond({
              requestId: request.requestId,
              status: 413,
              reason: "Payload Too Large",
              headers: [{ name: "content-type", value: "text/plain" }],
              body: new TextEncoder().encode(
                "request exceeds effect transport buffer"
              ),
            });
          }
          return resume(payload);
        } catch (error) {
          return resume(
            hostError(error instanceof Error ? error.message : String(error))
          );
        }
      },
    });
    implementedOps.add("accept_raw");

    registered += registerOpHandler({
      host,
      effectId: HTTP_SERVER_EFFECT_ID,
      opName: "respond_raw",
      handler: async ({ tail }, payload) => {
        try {
          await httpServerSource.respond(decodeResponsePayload(payload));
          return tail(hostOk());
        } catch (error) {
          return tail(hostError(error instanceof Error ? error.message : String(error)));
        }
      },
    });
    implementedOps.add("respond_raw");

    registered += registerOpHandler({
      host,
      effectId: HTTP_SERVER_EFFECT_ID,
      opName: "close_raw",
      handler: async ({ tail }, serverId) => {
        try {
          const parsedServerId = toNumberOrUndefined(serverId);
          if (parsedServerId === undefined) {
            throw new Error("http server close requires a server id");
          }
          await httpServerSource.close(Math.trunc(parsedServerId));
          return tail(hostOk());
        } catch (error) {
          return tail(hostError(error instanceof Error ? error.message : String(error)));
        }
      },
    });
    implementedOps.add("close_raw");

    return (
      registered +
      registerMissingOpHandlers({
        host,
        effectId: HTTP_SERVER_EFFECT_ID,
        implementedOps,
        diagnostics,
      })
    );
  },
};
