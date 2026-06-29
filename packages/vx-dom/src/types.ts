export type VxRenderFrame = {
  version: 1;
  root: VNode;
};

export type VNode =
  | VxTextNode
  | VxFragmentNode
  | VxElementNode;

export type VxTextNode = {
  kind: "text";
  value: string;
  key?: RenderKey;
};

export type VxFragmentNode = {
  kind: "fragment";
  children: VNode[];
  key?: RenderKey;
};

export type VxElementNode = {
  kind: "element";
  tag: string;
  key?: RenderKey;
  attrs?: Record<string, unknown>;
  props?: Record<string, unknown>;
  styles?: Record<string, string>;
  events?: EventDescriptor[];
  children?: VNode[];
};

export type RenderKey = string;

export type EventDescriptor = {
  kind: "event";
  event: string;
  handlerId?: number;
  message?: unknown;
  options?: EventOptions;
  mapHandlerIds?: number[];
};

export type EventOptions = {
  preventDefault?: boolean;
  stopPropagation?: boolean;
  capture?: boolean;
  passive?: boolean;
};

export type NormalizedEventPayload =
  | MouseEventPayload
  | KeyboardEventPayload
  | InputEventPayload
  | SubmitEventPayload
  | GenericEventPayload;

export type MouseEventPayload = {
  kind: "mouse" | "pointer" | "wheel" | "drag";
  x: number;
  y: number;
  client_x: number;
  client_y: number;
  button: number;
  alt_key: boolean;
  ctrl_key: boolean;
  meta_key: boolean;
  shift_key: boolean;
  delta_x: number;
  delta_y: number;
};

export type KeyboardEventPayload = {
  kind: "keyboard";
  key: string;
  code: string;
  alt_key: boolean;
  ctrl_key: boolean;
  meta_key: boolean;
  shift_key: boolean;
};

export type InputEventPayload = {
  kind: "input";
  value: string;
  checked: boolean;
  input_type: string;
};

export type SubmitEventPayload = {
  kind: "submit";
  form_data: Record<string, string>;
  form_keys: string[];
  form_values: string[];
};

export type GenericEventPayload = {
  kind: "event";
  event: string;
};

export type RetainedEventHandlerRegistry = {
  dispatch(id: number, payload: NormalizedEventPayload): Promise<unknown> | unknown;
  dispatchMapped?: (
    id: number,
    payload: NormalizedEventPayload,
    mapHandlerIds: readonly number[],
  ) => Promise<void> | void;
  dispatchMessage?: (message: unknown) => Promise<void> | void;
  release?: (id: number) => void;
  releaseMany?: (ids: Iterable<number>) => void;
};

export type CallOptions =
  | { instance: WebAssembly.Instance; memory?: undefined }
  | { instance?: undefined; memory: WebAssembly.Memory };

export type VoydComponentFn = () => number;

export type VxMessage =
  | { kind: "msgpack"; value: unknown }
  | { kind: "debug"; name: string; payload?: unknown };

export type VxRuntimeEventMessage = {
  kind: "event";
  handlerId: number;
  payload: NormalizedEventPayload;
};

export type VxRuntimeSubscriptionMessage = {
  kind: "subscription";
  subscriptionKind: string;
  key?: string;
  value?: unknown;
  payload: unknown;
};

export type VxRuntimeMapMessage = {
  kind: "map";
  handlerId: number;
  message: VxRuntimeMessage;
};

export type VxRuntimeMessage =
  | VxMessage
  | VxRuntimeEventMessage
  | VxRuntimeSubscriptionMessage
  | VxRuntimeMapMessage;

export type VxRuntimeStep = {
  frame?: unknown;
  commands?: unknown;
  subscriptions?: unknown;
  snapshot?: unknown;
};

export type VxRuntimeEnvelope = Record<string, unknown> & {
  type: string;
  kind: string;
};

export type VxCommandEnvelope = VxRuntimeEnvelope & {
  type: "cmd";
};

export type VxSubscriptionEnvelope = VxRuntimeEnvelope & {
  type: "sub";
};

export type VxRuntimeExecutionContext = {
  dispatch(message: VxRuntimeMessage): Promise<void>;
  deferAfterCommands?: (callback: () => void) => void;
  reportError?: VxRuntimeErrorHandler;
  signal: AbortSignal;
};

export type VxRuntimeErrorPhase =
  | "init"
  | "dispatch"
  | "render"
  | "subscriptions"
  | "commands"
  | "dispose";

export type VxRuntimeErrorContext = {
  phase: VxRuntimeErrorPhase;
  message?: VxRuntimeMessage;
};

export type VxRuntimeErrorHandler = (
  error: unknown,
  context: VxRuntimeErrorContext,
) => void;

export type VxCommandExecutor = (
  command: VxCommandEnvelope,
  context: VxRuntimeExecutionContext,
) => Promise<void> | void;

export type VxSubscriptionDisposer = () => Promise<void> | void;

export type VxSubscriptionRunner = (
  subscription: VxSubscriptionEnvelope,
  context: VxRuntimeExecutionContext,
) => Promise<VxSubscriptionDisposer | void> | VxSubscriptionDisposer | void;

export type VxRuntimeHostOptions = {
  commands?: Record<string, VxCommandExecutor>;
  subscriptions?: Record<string, VxSubscriptionRunner>;
  onError?: VxRuntimeErrorHandler;
};

export type VxSubscriptionSyncContext = {
  previous: unknown;
  dispatch(message: VxRuntimeMessage): Promise<void>;
};

export type VxAppRuntime = {
  init?: () => Promise<unknown> | unknown;
  render: () => Promise<unknown> | unknown;
  dispatch(message: VxRuntimeMessage): Promise<unknown> | unknown;
  retainedCallbacks?: {
    release?: (id: number) => void;
    releaseMany?: (ids: Iterable<number>) => void;
  };
  syncSubscriptions?: (
    next: unknown,
    context: VxSubscriptionSyncContext,
  ) => Promise<void> | void;
  dispose?: () => Promise<void> | void;
  getSnapshot?: () => unknown;
};
