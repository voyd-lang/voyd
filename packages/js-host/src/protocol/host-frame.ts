export const HOST_FRAME_VERSION = 2;

export type DtoFingerprint = string;

export type TypedHostPayload = {
  fingerprint: DtoFingerprint;
  value: unknown;
};

export type HostFailure = {
  code: string;
  message: string;
  path?: readonly (string | number)[];
};

export type HostOutcome =
  | { kind: "success"; value: TypedHostPayload }
  | { kind: "failure"; failure: HostFailure };

export type HostFrame =
  | {
      kind: "export-invocation";
      exportName: string;
      args: readonly TypedHostPayload[];
    }
  | {
      kind: "export-completion";
      exportName: string;
      outcome: HostOutcome;
    }
  | {
      kind: "effect-request";
      requestId: number;
      effectId: string;
      operationId: number;
      args: readonly TypedHostPayload[];
    }
  | {
      kind: "effect-outcome";
      requestId: number;
      outcome: HostOutcome;
    }
  | {
      kind: "callback-invocation";
      invocationId: number;
      callbackId: number;
      args: readonly TypedHostPayload[];
    }
  | {
      kind: "callback-completion";
      invocationId: number;
      outcome: HostOutcome;
    }
  | {
      kind: "cancellation";
      operationId: number;
      reason?: string;
    }
  | {
      kind: "cancellation-acknowledgement";
      operationId: number;
      accepted: boolean;
    }
  | {
      kind: "vx-command";
      sessionId: number;
      commandId: number;
      command: TypedHostPayload;
    }
  | {
      kind: "vx-event";
      sessionId: number;
      event: TypedHostPayload;
    }
  | {
      kind: "vx-extension-request";
      sessionId: number;
      requestId: number;
      extensionId: string;
      request: TypedHostPayload;
    }
  | {
      kind: "vx-extension-outcome";
      sessionId: number;
      requestId: number;
      outcome: HostOutcome;
    }
  | {
      kind: "external-invocation";
      interfaceId: string;
      functionName: string;
      args: readonly TypedHostPayload[];
    }
  | {
      kind: "external-completion";
      interfaceId: string;
      functionName: string;
      outcome: HostOutcome;
    };
