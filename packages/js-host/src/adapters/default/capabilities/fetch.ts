import {
  fetchSuccessPayload,
  globalRecord,
  hostError,
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
  FETCH_EFFECT_ID,
  type CapabilityDefinition,
  type DefaultAdapterFetchHeader,
  type DefaultAdapterFetchRequest,
  type DefaultAdapterFetchResponse,
} from "../types.js";

const toFetchHeader = (value: unknown): DefaultAdapterFetchHeader | undefined => {
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

const normalizeFetchHeaders = (value: unknown): DefaultAdapterFetchHeader[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.reduce<DefaultAdapterFetchHeader[]>((headers, entry) => {
    const next = toFetchHeader(entry);
    if (next) {
      headers.push(next);
    }
    return headers;
  }, []);
};

const decodeFetchRequest = (payload: unknown): DefaultAdapterFetchRequest => {
  const url = toStringOrUndefined(readField(payload, "url"))?.trim();
  if (!url) {
    throw new Error("fetch request payload must include a non-empty url");
  }
  const method = toStringOrUndefined(readField(payload, "method"))?.trim();
  const timeoutRaw =
    readField(payload, "timeout_millis") ?? readField(payload, "timeoutMillis");
  const timeoutParsed = toNumberOrUndefined(timeoutRaw);
  return {
    method: method && method.length > 0 ? method.toUpperCase() : "GET",
    url,
    headers: normalizeFetchHeaders(readField(payload, "headers")),
    body: toStringOrUndefined(readField(payload, "body")),
    timeoutMillis:
      timeoutParsed === undefined
        ? undefined
        : Math.max(0, Math.trunc(timeoutParsed)),
  };
};

const normalizeFetchResponseHeaders = (
  value: unknown
): DefaultAdapterFetchHeader[] => {
  if (Array.isArray(value)) {
    return value.reduce<DefaultAdapterFetchHeader[]>((headers, entry) => {
      const next = toFetchHeader(entry);
      if (next) {
        headers.push(next);
      }
      return headers;
    }, []);
  }

  if (value instanceof Map) {
    return Array.from(value.entries()).reduce<DefaultAdapterFetchHeader[]>(
      (headers, entry) => {
        const next = toFetchHeader(entry);
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
    return Array.from(iter).reduce<DefaultAdapterFetchHeader[]>((headers, entry) => {
      const next = toFetchHeader(entry);
      if (next) {
        headers.push(next);
      }
      return headers;
    }, []);
  }

  const forEach = readField(value, "forEach");
  if (typeof forEach === "function") {
    const headers: DefaultAdapterFetchHeader[] = [];
    (
      forEach as (
        callback: (headerValue: unknown, nameValue: unknown) => void
      ) => void
    ).call(value, (headerValue: unknown, nameValue: unknown) => {
      const next = toFetchHeader([nameValue, headerValue]);
      if (next) {
        headers.push(next);
      }
    });
    return headers;
  }

  return Object.entries(value).reduce<DefaultAdapterFetchHeader[]>(
    (headers, [nameValue, headerValue]) => {
      const next = toFetchHeader([nameValue, headerValue]);
      if (next) {
        headers.push(next);
      }
      return headers;
    },
    []
  );
};

const decodeFetchResponse = async (
  response: unknown
): Promise<DefaultAdapterFetchResponse> => {
  const status = toNumberOrUndefined(readField(response, "status"));
  if (status === undefined) {
    throw new Error("fetch response is missing status");
  }
  const statusText = toStringOrUndefined(readField(response, "statusText")) ?? "";
  const headers = normalizeFetchResponseHeaders(readField(response, "headers"));
  const text = readField(response, "text");
  if (typeof text === "function") {
    const bodyValue = await (text as () => Promise<unknown>).call(response);
    return {
      status: Math.trunc(status),
      statusText,
      headers,
      body: toStringOrUndefined(bodyValue) ?? String(bodyValue ?? ""),
    };
  }

  return {
    status: Math.trunc(status),
    statusText,
    headers,
    body: toStringOrUndefined(readField(response, "body")) ?? "",
  };
};

type FetchSource = {
  isAvailable: boolean;
  unavailableReason: string;
  request: (input: DefaultAdapterFetchRequest) => Promise<DefaultAdapterFetchResponse>;
};

const createFetchSource = ({
  fetchRequest,
}: {
  fetchRequest?: (
    request: DefaultAdapterFetchRequest
  ) => Promise<DefaultAdapterFetchResponse>;
}): FetchSource => {
  if (typeof fetchRequest === "function") {
    return {
      isAvailable: true,
      unavailableReason: "",
      request: fetchRequest,
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
      const init: Record<string, unknown> = {
        method: input.method,
        headers: input.headers.map((header) => [header.name, header.value]),
      };
      if (input.body !== undefined) {
        init.body = input.body;
      }

      const timeoutMillis = input.timeoutMillis ?? 0;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMillis > 0) {
        const AbortControllerCtor = globalRecord.AbortController as
          | (new () => { signal: unknown; abort: (reason?: unknown) => void })
          | undefined;
        if (typeof AbortControllerCtor !== "function") {
          throw new Error("fetch timeout_millis requires AbortController support");
        }
        if (typeof setTimeout !== "function") {
          throw new Error("fetch timeout_millis requires setTimeout support");
        }
        const controller = new AbortControllerCtor();
        timeoutHandle = setTimeout(() => {
          controller.abort("timeout");
        }, timeoutMillis);
        init.signal = controller.signal;
      }

      try {
        const response = await fetchFn(input.url, init);
        return await decodeFetchResponse(response);
      } finally {
        if (timeoutHandle !== undefined && typeof clearTimeout === "function") {
          clearTimeout(timeoutHandle);
        }
      }
    },
  };
};

export const fetchCapabilityDefinition: CapabilityDefinition = {
  capability: "fetch",
  effectId: FETCH_EFFECT_ID,
  register: async ({
    host,
    runtime,
    diagnostics,
    runtimeHooks,
    effectBufferSize,
  }) => {
    const entries = opEntries({ host, effectId: FETCH_EFFECT_ID });
    if (entries.length === 0) {
      return 0;
    }

    const fetchSource = createFetchSource({
      fetchRequest: runtimeHooks.fetchRequest,
    });
    if (!fetchSource.isAvailable) {
      return registerUnsupportedHandlers({
        host,
        effectId: FETCH_EFFECT_ID,
        capability: "fetch",
        runtime,
        reason: fetchSource.unavailableReason,
        diagnostics,
      });
    }

    const implementedOps = new Set<string>();
    const registered = registerOpHandler({
      host,
      effectId: FETCH_EFFECT_ID,
      opName: "request",
      handler: async ({ tail }, payload) => {
        try {
          const request = decodeFetchRequest(payload);
          const response = await fetchSource.request(request);
          return tail(
            fetchSuccessPayload({
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
        effectId: FETCH_EFFECT_ID,
        implementedOps,
        diagnostics,
      })
    );
  },
};
