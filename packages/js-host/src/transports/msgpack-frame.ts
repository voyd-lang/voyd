import type {
  HostFailure,
  HostFrame,
  HostOutcome,
  TypedHostPayload,
} from "../protocol/host-frame.js";
import { HOST_FRAME_VERSION } from "../protocol/host-frame.js";

const TAG = {
  exportInvocation: 0,
  exportCompletion: 1,
  effectRequest: 2,
  effectOutcome: 3,
  callbackInvocation: 4,
  callbackCompletion: 5,
  cancellation: 6,
  cancellationAcknowledgement: 7,
  vxCommand: 8,
  vxEvent: 9,
  vxExtensionRequest: 10,
  vxExtensionOutcome: 11,
  externalInvocation: 12,
  externalCompletion: 13,
} as const;

export const toMsgPackHostFrame = (frame: HostFrame): unknown[] => {
  switch (frame.kind) {
    case "export-invocation":
      return [
        HOST_FRAME_VERSION,
        TAG.exportInvocation,
        frame.exportId,
        frame.args.map(toTypedPayload),
      ];
    case "export-completion":
      return [
        HOST_FRAME_VERSION,
        TAG.exportCompletion,
        frame.exportId,
        toOutcome(frame.outcome),
      ];
    case "effect-request":
      return [
        HOST_FRAME_VERSION,
        TAG.effectRequest,
        frame.requestId,
        frame.effectId,
        frame.operationId,
        frame.signatureHash,
        frame.resumeKind,
        frame.args.map(toTypedPayload),
        frame.resultFingerprint,
      ];
    case "effect-outcome":
      return [
        HOST_FRAME_VERSION,
        TAG.effectOutcome,
        frame.requestId,
        toOutcome(frame.outcome),
      ];
    case "callback-invocation":
      return [
        HOST_FRAME_VERSION,
        TAG.callbackInvocation,
        frame.invocationId,
        frame.callbackId,
        frame.args.map(toTypedPayload),
      ];
    case "callback-completion":
      return [
        HOST_FRAME_VERSION,
        TAG.callbackCompletion,
        frame.invocationId,
        toOutcome(frame.outcome),
      ];
    case "cancellation":
      return [
        HOST_FRAME_VERSION,
        TAG.cancellation,
        frame.operationId,
        frame.reason ?? null,
      ];
    case "cancellation-acknowledgement":
      return [
        HOST_FRAME_VERSION,
        TAG.cancellationAcknowledgement,
        frame.operationId,
        frame.accepted,
      ];
    case "vx-command":
      return [
        HOST_FRAME_VERSION,
        TAG.vxCommand,
        frame.sessionId,
        frame.commandId,
        toTypedPayload(frame.command),
      ];
    case "vx-event":
      return [
        HOST_FRAME_VERSION,
        TAG.vxEvent,
        frame.sessionId,
        toTypedPayload(frame.event),
      ];
    case "vx-extension-request":
      return [
        HOST_FRAME_VERSION,
        TAG.vxExtensionRequest,
        frame.sessionId,
        frame.requestId,
        frame.extensionId,
        toTypedPayload(frame.request),
      ];
    case "vx-extension-outcome":
      return [
        HOST_FRAME_VERSION,
        TAG.vxExtensionOutcome,
        frame.sessionId,
        frame.requestId,
        toOutcome(frame.outcome),
      ];
    case "external-invocation":
      return [
        HOST_FRAME_VERSION,
        TAG.externalInvocation,
        frame.interfaceId,
        frame.functionName,
        frame.args.map(toTypedPayload),
      ];
    case "external-completion":
      return [
        HOST_FRAME_VERSION,
        TAG.externalCompletion,
        frame.interfaceId,
        frame.functionName,
        toOutcome(frame.outcome),
      ];
  }
};

export const fromMsgPackHostFrame = (value: unknown): HostFrame => {
  const frame = arrayValue(value, "frame");
  const version = numberValue(frame[0], "frame version");
  if (version !== HOST_FRAME_VERSION) {
    throw new Error(
      `Unsupported Voyd host frame version ${version}; expected ${HOST_FRAME_VERSION}`,
    );
  }
  const tag = numberValue(frame[1], "frame tag");
  switch (tag) {
    case TAG.exportInvocation:
      return {
        kind: "export-invocation",
        exportId: numberValue(frame[2], "export id"),
        args: typedPayloads(frame[3], "export arguments"),
      };
    case TAG.exportCompletion:
      return {
        kind: "export-completion",
        exportId: numberValue(frame[2], "export id"),
        outcome: outcomeValue(frame[3]),
      };
    case TAG.effectRequest:
      return {
        kind: "effect-request",
        requestId: numberValue(frame[2], "effect request id"),
        effectId: stringValue(frame[3], "effect id"),
        operationId: numberValue(frame[4], "effect operation id"),
        signatureHash: numberValue(frame[5], "effect signature hash"),
        resumeKind: numberValue(frame[6], "effect resume kind"),
        args: typedPayloads(frame[7], "effect arguments"),
        resultFingerprint: stringValue(frame[8], "effect result fingerprint"),
      };
    case TAG.effectOutcome:
      return {
        kind: "effect-outcome",
        requestId: numberValue(frame[2], "effect request id"),
        outcome: outcomeValue(frame[3]),
      };
    case TAG.callbackInvocation:
      return {
        kind: "callback-invocation",
        invocationId: numberValue(frame[2], "callback invocation id"),
        callbackId: numberValue(frame[3], "callback id"),
        args: typedPayloads(frame[4], "callback arguments"),
      };
    case TAG.callbackCompletion:
      return {
        kind: "callback-completion",
        invocationId: numberValue(frame[2], "callback invocation id"),
        outcome: outcomeValue(frame[3]),
      };
    case TAG.cancellation:
      return {
        kind: "cancellation",
        operationId: numberValue(frame[2], "cancelled operation id"),
        ...(frame[3] === null
          ? {}
          : { reason: stringValue(frame[3], "cancellation reason") }),
      };
    case TAG.cancellationAcknowledgement:
      return {
        kind: "cancellation-acknowledgement",
        operationId: numberValue(frame[2], "cancelled operation id"),
        accepted: booleanValue(frame[3], "cancellation acknowledgement"),
      };
    case TAG.vxCommand:
      return {
        kind: "vx-command",
        sessionId: numberValue(frame[2], "VX session id"),
        commandId: numberValue(frame[3], "VX command id"),
        command: typedPayload(frame[4], "VX command"),
      };
    case TAG.vxEvent:
      return {
        kind: "vx-event",
        sessionId: numberValue(frame[2], "VX session id"),
        event: typedPayload(frame[3], "VX event"),
      };
    case TAG.vxExtensionRequest:
      return {
        kind: "vx-extension-request",
        sessionId: numberValue(frame[2], "VX session id"),
        requestId: numberValue(frame[3], "VX extension request id"),
        extensionId: stringValue(frame[4], "VX extension id"),
        request: typedPayload(frame[5], "VX extension request"),
      };
    case TAG.vxExtensionOutcome:
      return {
        kind: "vx-extension-outcome",
        sessionId: numberValue(frame[2], "VX session id"),
        requestId: numberValue(frame[3], "VX extension request id"),
        outcome: outcomeValue(frame[4]),
      };
    case TAG.externalInvocation:
      return {
        kind: "external-invocation",
        interfaceId: stringValue(frame[2], "external interface id"),
        functionName: stringValue(frame[3], "external function name"),
        args: typedPayloads(frame[4], "external arguments"),
      };
    case TAG.externalCompletion:
      return {
        kind: "external-completion",
        interfaceId: stringValue(frame[2], "external interface id"),
        functionName: stringValue(frame[3], "external function name"),
        outcome: outcomeValue(frame[4]),
      };
    default:
      throw new Error(`Unknown Voyd host frame tag ${tag}`);
  }
};

const toTypedPayload = ({
  fingerprint,
  value,
}: TypedHostPayload): unknown[] => [fingerprint, value];

const typedPayload = (value: unknown, label: string): TypedHostPayload => {
  const tuple = arrayValue(value, label);
  return {
    fingerprint: stringValue(tuple[0], `${label} fingerprint`),
    value: tuple[1],
  };
};

const typedPayloads = (
  value: unknown,
  label: string,
): readonly TypedHostPayload[] =>
  arrayValue(value, label).map((item, index) =>
    typedPayload(item, `${label}[${index}]`),
  );

const toOutcome = (outcome: HostOutcome): unknown[] =>
  outcome.kind === "success"
    ? [0, toTypedPayload(outcome.value)]
    : [1, toFailure(outcome.failure)];

const outcomeValue = (value: unknown): HostOutcome => {
  const tuple = arrayValue(value, "host outcome");
  const tag = numberValue(tuple[0], "host outcome tag");
  if (tag === 0) {
    return { kind: "success", value: typedPayload(tuple[1], "host result") };
  }
  if (tag === 1) {
    return { kind: "failure", failure: failureValue(tuple[1]) };
  }
  throw new Error(`Unknown Voyd host outcome tag ${tag}`);
};

const toFailure = (failure: HostFailure): unknown[] => [
  failure.direction,
  failure.frameCategory,
  failure.phase,
  failure.category,
  failure.code,
  failure.providerCode,
  failure.message,
  failure.path ?? null,
];

const failureValue = (value: unknown): HostFailure => {
  const tuple = arrayValue(value, "host failure");
  const path = tuple[7];
  return {
    direction: hostFailureDirection(tuple[0]),
    frameCategory: hostFrameCategory(tuple[1]),
    phase: hostFailurePhase(tuple[2]),
    category: hostFailureCategory(tuple[3]),
    code: stringValue(tuple[4], "host failure code"),
    providerCode: stringValue(tuple[5], "host failure provider code"),
    message: stringValue(tuple[6], "host failure message"),
    ...(path === null || path === undefined
      ? {}
      : {
          path: arrayValue(path, "host failure path").map((part, index) => {
            if (typeof part === "string" || typeof part === "number") {
              return part;
            }
            throw new Error(
              `host failure path[${index}] must be text or a number`,
            );
          }),
        }),
  };
};

const enumString = <Value extends string>(
  value: unknown,
  label: string,
  allowed: readonly Value[],
): Value => {
  const parsed = stringValue(value, label);
  if (!allowed.includes(parsed as Value)) {
    throw new Error(`${label} has unknown value '${parsed}'`);
  }
  return parsed as Value;
};

const hostFailureDirection = (
  value: unknown,
): HostFailure["direction"] =>
  enumString(value, "host failure direction", ["host->vm", "vm->host", "vm"]);

const hostFailurePhase = (value: unknown): HostFailure["phase"] =>
  enumString(value, "host failure phase", [
    "encode",
    "decode",
    "validate",
    "dispatch",
    "execute",
    "cancel",
  ]);

const hostFailureCategory = (value: unknown): HostFailure["category"] =>
  enumString(value, "host failure category", [
    "source",
    "sink",
    "structural",
    "custom",
    "runtime",
  ]);

const hostFrameCategory = (value: unknown): HostFrame["kind"] =>
  enumString(value, "host failure frame category", [
    "export-invocation",
    "export-completion",
    "effect-request",
    "effect-outcome",
    "callback-invocation",
    "callback-completion",
    "cancellation",
    "cancellation-acknowledgement",
    "vx-command",
    "vx-event",
    "vx-extension-request",
    "vx-extension-outcome",
    "external-invocation",
    "external-completion",
  ]);

const arrayValue = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
};

const stringValue = (value: unknown, label: string): string => {
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  return value;
};

const numberValue = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer`);
  }
  return value;
};

const booleanValue = (value: unknown, label: string): boolean => {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
};
