import {
  globalRecord,
  hostError,
  httpClientSuccessPayload,
  isRecord,
  readField,
  toNumberOrUndefined,
  toStringOrUndefined,
} from "../helpers.js";
import { fetchErrorCode, fetchErrorMessage } from "../errors.js";
import {
  opEntries,
  registerMissingOpHandlers,
  registerOpHandler,
  registerUnsupportedHandlers,
} from "../registration.js";
import {
  HTTP_CLIENT_EFFECT_ID,
  type CapabilityDefinition,
  type DefaultAdapterHttpClientRequest,
  type DefaultAdapterHttpClientResponse,
  type DefaultAdapterHttpHeader,
  type DefaultAdapterHttpRedirectPolicy,
} from "../types.js";

const textEncoder = new TextEncoder();
const DEFAULT_FETCH_MAX_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const REDIRECT_CREDENTIAL_HEADERS = new Set([
  "authorization",
  "cookie",
  "cookie2",
  "proxy-authorization",
]);
const REDIRECT_BODY_HEADERS = new Set([
  "content-encoding",
  "content-language",
  "content-length",
  "content-location",
  "content-type",
  "trailer",
  "transfer-encoding",
]);

const toHttpHeader = (value: unknown): DefaultAdapterHttpHeader | undefined => {
  if (Array.isArray(value)) {
    const [nameValue, headerValue] = value;
    const name = toStringOrUndefined(nameValue)?.trim();
    if (!name) {
      return undefined;
    }
    return {
      name,
      value: toStringOrUndefined(headerValue) ?? String(headerValue ?? ""),
    };
  }

  const name = toStringOrUndefined(readField(value, "name"))?.trim();
  if (!name) {
    return undefined;
  }
  return {
    name,
    value:
      toStringOrUndefined(readField(value, "value")) ??
      String(readField(value, "value") ?? ""),
  };
};

const normalizeHttpHeaders = (value: unknown): DefaultAdapterHttpHeader[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.reduce<DefaultAdapterHttpHeader[]>((headers, entry) => {
    const next = toHttpHeader(entry);
    if (next) {
      headers.push(next);
    }
    return headers;
  }, []);
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
    return textEncoder.encode(value);
  }
  return new Uint8Array();
};

const decodeRedirectPolicy = (
  value: unknown
): DefaultAdapterHttpRedirectPolicy => {
  const kind = toStringOrUndefined(readField(value, "kind"))?.toLowerCase();
  if (kind === "manual") {
    return { kind: "manual" };
  }
  if (kind === "error") {
    return { kind: "error" };
  }
  const rawMax = toNumberOrUndefined(readField(value, "max_redirects"));
  const maxRedirects =
    rawMax === undefined ? 20 : Math.max(0, Math.trunc(rawMax));
  return { kind: "follow", maxRedirects };
};

const decodeHttpClientRequest = (
  payload: unknown
): DefaultAdapterHttpClientRequest => {
  const url = toStringOrUndefined(readField(payload, "url"))?.trim();
  if (!url) {
    throw new Error("http client request payload must include a non-empty url");
  }
  const method = toStringOrUndefined(readField(payload, "method"))?.trim();
  const timeoutRaw =
    readField(payload, "timeout_millis") ?? readField(payload, "timeoutMillis");
  const timeoutParsed = toNumberOrUndefined(timeoutRaw);
  return {
    method: method && method.length > 0 ? method : "GET",
    url,
    headers: normalizeHttpHeaders(readField(payload, "headers")),
    body: toByteArray(readField(payload, "body")),
    timeoutMillis:
      timeoutParsed === undefined
        ? undefined
        : Math.max(0, Math.trunc(timeoutParsed)),
    redirectPolicy: decodeRedirectPolicy(readField(payload, "redirect_policy")),
  };
};

const normalizeHttpResponseHeaders = (
  value: unknown
): DefaultAdapterHttpHeader[] => {
  if (Array.isArray(value)) {
    return value.reduce<DefaultAdapterHttpHeader[]>((headers, entry) => {
      const next = toHttpHeader(entry);
      if (next) {
        headers.push(next);
      }
      return headers;
    }, []);
  }

  if (value instanceof Map) {
    return Array.from(value.entries()).reduce<DefaultAdapterHttpHeader[]>(
      (headers, entry) => {
        const next = toHttpHeader(entry);
        if (next) {
          headers.push(next);
        }
        return headers;
      },
      []
    );
  }

  if (!isRecord(value)) {
    return [];
  }

  const entries = readField(value, "entries");
  if (typeof entries === "function") {
    const iter = (entries as () => Iterable<unknown>).call(value);
    return Array.from(iter).reduce<DefaultAdapterHttpHeader[]>((headers, entry) => {
      const next = toHttpHeader(entry);
      if (next) {
        headers.push(next);
      }
      return headers;
    }, []);
  }

  const forEach = readField(value, "forEach");
  if (typeof forEach === "function") {
    const headers: DefaultAdapterHttpHeader[] = [];
    (
      forEach as (
        callback: (headerValue: unknown, nameValue: unknown) => void
      ) => void
    ).call(value, (headerValue: unknown, nameValue: unknown) => {
      const next = toHttpHeader([nameValue, headerValue]);
      if (next) {
        headers.push(next);
      }
    });
    return headers;
  }

  return Object.entries(value).reduce<DefaultAdapterHttpHeader[]>(
    (headers, [nameValue, headerValue]) => {
      const next = toHttpHeader([nameValue, headerValue]);
      if (next) {
        headers.push(next);
      }
      return headers;
    },
    []
  );
};

const decodeHttpClientResponse = async (
  response: unknown
): Promise<DefaultAdapterHttpClientResponse> => {
  const status = toNumberOrUndefined(readField(response, "status"));
  if (status === undefined) {
    throw new Error("http client response is missing status");
  }
  const reason =
    toStringOrUndefined(readField(response, "reason")) ??
    toStringOrUndefined(readField(response, "statusText")) ??
    "";
  const headers = normalizeHttpResponseHeaders(readField(response, "headers"));
  const arrayBuffer = readField(response, "arrayBuffer");
  if (typeof arrayBuffer === "function") {
    const bodyValue = await (arrayBuffer as () => Promise<unknown>).call(response);
    return {
      status: Math.trunc(status),
      reason,
      headers,
      body: toByteArray(bodyValue),
    };
  }

  const text = readField(response, "text");
  if (typeof text === "function") {
    const bodyValue = await (text as () => Promise<unknown>).call(response);
    return {
      status: Math.trunc(status),
      reason,
      headers,
      body: toByteArray(bodyValue),
    };
  }

  return {
    status: Math.trunc(status),
    reason,
    headers,
    body: toByteArray(readField(response, "body")),
  };
};

const redirectLocation = (response: unknown): string | undefined => {
  const headers = normalizeHttpResponseHeaders(readField(response, "headers"));
  return headers.find((header) => header.name.toLowerCase() === "location")?.value;
};

const redirectUrl = ({
  currentUrl,
  location,
}: {
  currentUrl: string;
  location: string;
}): string => {
  try {
    return new URL(location, currentUrl).toString();
  } catch {
    throw new Error(`invalid redirect location: ${location}`);
  }
};

const shouldSwitchRedirectToGet = ({
  status,
  method,
}: {
  status: number;
  method: string;
}): boolean =>
  (status === 303 && method.toUpperCase() !== "HEAD") ||
  ((status === 301 || status === 302) && method.toUpperCase() === "POST");

const hasSameOrigin = ({
  fromUrl,
  toUrl,
}: {
  fromUrl: string;
  toUrl: string;
}): boolean => {
  try {
    return new URL(fromUrl).origin === new URL(toUrl).origin;
  } catch {
    return false;
  }
};

const redirectHeaders = ({
  headers,
  fromUrl,
  toUrl,
  droppedBody,
}: {
  headers: DefaultAdapterHttpHeader[];
  fromUrl: string;
  toUrl: string;
  droppedBody: boolean;
}): DefaultAdapterHttpHeader[] => {
  const sameOrigin = hasSameOrigin({ fromUrl, toUrl });
  return headers.filter((header) => {
    const name = header.name.trim().toLowerCase();
    if (droppedBody && REDIRECT_BODY_HEADERS.has(name)) {
      return false;
    }
    return sameOrigin || !REDIRECT_CREDENTIAL_HEADERS.has(name);
  });
};

const fetchInit = ({
  headers,
  method,
  body,
  redirect,
  signal,
}: {
  headers: DefaultAdapterHttpHeader[];
  method: string;
  body: Uint8Array;
  redirect: string;
  signal?: unknown;
}): Record<string, unknown> => {
  const init: Record<string, unknown> = {
    method,
    headers: headers.map((header) => [header.name, header.value]),
    redirect,
  };
  if (body.byteLength > 0 && method !== "GET" && method !== "HEAD") {
    init.body = body;
  }
  if (signal !== undefined) {
    init.signal = signal;
  }
  return init;
};

const fetchWithManualRedirectLimit = async ({
  fetchFn,
  input,
  signal,
}: {
  fetchFn: (input: string, init?: Record<string, unknown>) => Promise<unknown>;
  input: DefaultAdapterHttpClientRequest;
  signal?: unknown;
}): Promise<DefaultAdapterHttpClientResponse> => {
  if (input.redirectPolicy.kind !== "follow") {
    throw new Error("manual redirect limit requires follow policy");
  }

  let url = input.url;
  let method = input.method;
  let headers = input.headers;
  let body = input.body;
  let redirects = 0;

  while (true) {
    const response = await fetchFn(
      url,
      fetchInit({ headers, method, body, redirect: "manual", signal })
    );
    const status = toNumberOrUndefined(readField(response, "status"));
    if (status === undefined || !REDIRECT_STATUSES.has(Math.trunc(status))) {
      return decodeHttpClientResponse(response);
    }

    const location = redirectLocation(response);
    if (!location) {
      return decodeHttpClientResponse(response);
    }

    if (redirects >= input.redirectPolicy.maxRedirects) {
      throw new Error(
        `http redirect limit exceeded (${input.redirectPolicy.maxRedirects})`
      );
    }

    redirects += 1;
    const previousUrl = url;
    const nextUrl = redirectUrl({ currentUrl: url, location });
    const droppedBody = shouldSwitchRedirectToGet({
      status: Math.trunc(status),
      method,
    });
    headers = redirectHeaders({
      headers,
      fromUrl: previousUrl,
      toUrl: nextUrl,
      droppedBody,
    });
    url = nextUrl;
    if (droppedBody) {
      method = "GET";
      body = new Uint8Array();
    }
  }
};

type HttpClientSource = {
  isAvailable: boolean;
  unavailableReason: string;
  request: (
    input: DefaultAdapterHttpClientRequest
  ) => Promise<DefaultAdapterHttpClientResponse>;
};

const createHttpClientSource = ({
  httpClientRequest,
}: {
  httpClientRequest?: (
    request: DefaultAdapterHttpClientRequest
  ) => Promise<DefaultAdapterHttpClientResponse>;
}): HttpClientSource => {
  if (typeof httpClientRequest === "function") {
    return {
      isAvailable: true,
      unavailableReason: "",
      request: httpClientRequest,
    };
  }

  const fetchValue = globalRecord.fetch;
  if (typeof fetchValue !== "function") {
    const unavailableReason = "fetch API is unavailable";
    return {
      isAvailable: false,
      unavailableReason,
      request: async () => {
        throw new Error(unavailableReason);
      },
    };
  }

  const fetchFn = (
    fetchValue as (input: string, init?: Record<string, unknown>) => Promise<unknown>
  ).bind(globalThis);

  return {
    isAvailable: true,
    unavailableReason: "",
    request: async (input) => {
      const timeoutMillis = input.timeoutMillis ?? 0;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let signal: unknown;
      if (timeoutMillis > 0) {
        const AbortControllerCtor = globalRecord.AbortController as
          | (new () => { signal: unknown; abort: (reason?: unknown) => void })
          | undefined;
        if (typeof AbortControllerCtor !== "function") {
          throw new Error("http client timeout_millis requires AbortController support");
        }
        if (typeof setTimeout !== "function") {
          throw new Error("http client timeout_millis requires setTimeout support");
        }
        const controller = new AbortControllerCtor();
        timeoutHandle = setTimeout(() => {
          controller.abort("timeout");
        }, timeoutMillis);
        signal = controller.signal;
      }

      try {
        if (
          input.redirectPolicy.kind === "follow" &&
          input.redirectPolicy.maxRedirects !== DEFAULT_FETCH_MAX_REDIRECTS
        ) {
          return await fetchWithManualRedirectLimit({ fetchFn, input, signal });
        }

        const response = await fetchFn(
          input.url,
          fetchInit({
            headers: input.headers,
            method: input.method,
            body: input.body,
            redirect: input.redirectPolicy.kind,
            signal,
          })
        );
        return await decodeHttpClientResponse(response);
      } finally {
        if (timeoutHandle !== undefined && typeof clearTimeout === "function") {
          clearTimeout(timeoutHandle);
        }
      }
    },
  };
};

export const httpClientCapabilityDefinition: CapabilityDefinition = {
  capability: "http-client",
  effectId: HTTP_CLIENT_EFFECT_ID,
  register: async ({
    host,
    runtime,
    diagnostics,
    runtimeHooks,
    effectBufferSize,
  }) => {
    const entries = opEntries({ host, effectId: HTTP_CLIENT_EFFECT_ID });
    if (entries.length === 0) {
      return 0;
    }

    const httpClientSource = createHttpClientSource({
      httpClientRequest: runtimeHooks.httpClientRequest,
    });
    if (!httpClientSource.isAvailable) {
      return registerUnsupportedHandlers({
        host,
        effectId: HTTP_CLIENT_EFFECT_ID,
        capability: "http-client",
        runtime,
        reason: httpClientSource.unavailableReason,
        diagnostics,
      });
    }

    const implementedOps = new Set<string>();
    const registered = registerOpHandler({
      host,
      effectId: HTTP_CLIENT_EFFECT_ID,
      opName: "request",
      handler: async ({ tail }, payload) => {
        try {
          const request = decodeHttpClientRequest(payload);
          const response = await httpClientSource.request(request);
          return tail(
            httpClientSuccessPayload({
              response,
              effectBufferSize,
            })
          );
        } catch (error) {
          return tail(hostError(fetchErrorMessage(error), fetchErrorCode(error)));
        }
      },
    });
    implementedOps.add("request");

    return (
      registered +
      registerMissingOpHandlers({
        host,
        effectId: HTTP_CLIENT_EFFECT_ID,
        implementedOps,
        diagnostics,
      })
    );
  },
};
