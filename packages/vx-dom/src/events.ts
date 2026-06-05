import type {
  EventDescriptor,
  EventOptions,
  GenericEventPayload,
  InputEventPayload,
  KeyboardEventPayload,
  MouseEventPayload,
  NormalizedEventPayload,
  SubmitEventPayload,
} from "./types.js";

export const listenerKey = (event: EventDescriptor): string =>
  [
    event.event,
    event.handlerId ?? `message:${stableEventValue(event.message)}`,
    bool(event.options?.capture),
    bool(event.options?.passive),
    bool(event.options?.preventDefault),
    bool(event.options?.stopPropagation),
  ].join(":");

export function toListenerOptions(options: EventOptions | undefined): AddEventListenerOptions {
  return {
    capture: options?.capture ?? false,
    passive: options?.passive ?? false,
  };
}

export function normalizeBrowserEvent(event: Event): NormalizedEventPayload {
  if (isInstance(event, "InputEvent") || event.type === "input" || event.type === "change") {
    return normalizeInputEvent(event);
  }
  if (isInstance(event, "SubmitEvent") || event.type === "submit") return normalizeSubmitEvent(event);
  if (isKeyboardEventName(event.type) || isInstance(event, "KeyboardEvent")) {
    return normalizeKeyboardEvent(event as KeyboardEvent);
  }
  if (event.type === "wheel" || isInstance(event, "WheelEvent")) {
    return normalizeMouseEvent(event as WheelEvent, "wheel");
  }
  if (isPointerEventName(event.type)) return normalizeMouseEvent(event as PointerEvent, "pointer");
  if (isDragEventName(event.type)) return normalizeMouseEvent(event as DragEvent, "drag");
  if (isInstance(event, "MouseEvent")) return normalizeMouseEvent(event as MouseEvent, "mouse");
  return normalizeGenericEvent(event);
}

function normalizeKeyboardEvent(event: KeyboardEvent): KeyboardEventPayload {
  return {
    kind: "keyboard",
    key: event.key,
    code: event.code,
    alt_key: event.altKey,
    ctrl_key: event.ctrlKey,
    meta_key: event.metaKey,
    shift_key: event.shiftKey,
  };
}

function normalizeInputEvent(event: Event): InputEventPayload {
  const target = event.target;
  const input = isInputTarget(target) ? target : undefined;
  const payload: InputEventPayload = {
    kind: "input",
    value: input?.value ?? "",
    checked: input && "checked" in input ? input.checked : false,
  };
  const maybeInput = event as InputEvent;
  if (typeof maybeInput.inputType === "string" && maybeInput.inputType) {
    payload.input_type = maybeInput.inputType;
  }
  return payload;
}

function normalizeSubmitEvent(event: Event): SubmitEventPayload {
  const target = event.target;
  const form = isInstance(target, "HTMLFormElement")
    ? (target as HTMLFormElement)
    : undefined;
  const formData = form ? new FormData(form) : undefined;
  const entries = formData
    ? Array.from(formData.entries()).map(([key, value]) => [key, String(value)])
    : [];
  return {
    kind: "submit",
    form_data: Object.fromEntries(entries),
  };
}

function normalizeMouseEvent(
  event: MouseEvent | PointerEvent | WheelEvent | DragEvent,
  kind: MouseEventPayload["kind"],
): MouseEventPayload {
  const payload: MouseEventPayload = {
    kind,
    x: event.x ?? event.clientX,
    y: event.y ?? event.clientY,
    client_x: event.clientX,
    client_y: event.clientY,
    button: event.button,
    alt_key: event.altKey,
    ctrl_key: event.ctrlKey,
    meta_key: event.metaKey,
    shift_key: event.shiftKey,
  };
  if (isInstance(event, "WheelEvent")) {
    const wheel = event as WheelEvent;
    payload.delta_x = wheel.deltaX;
    payload.delta_y = wheel.deltaY;
  }
  return payload;
}

function normalizeGenericEvent(event: Event): GenericEventPayload {
  return { kind: "event", event: event.type };
}

function isInputTarget(
  target: EventTarget | null,
): target is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  return (
    isInstance(target, "HTMLInputElement") ||
    isInstance(target, "HTMLTextAreaElement") ||
    isInstance(target, "HTMLSelectElement")
  );
}

function bool(value: boolean | undefined): 0 | 1 {
  return value ? 1 : 0;
}

function stableEventValue(input: unknown): string {
  if (input instanceof Map) {
    return stableEventValue(Object.fromEntries(input.entries()));
  }
  if (Array.isArray(input)) {
    return `[${input.map(stableEventValue).join(",")}]`;
  }
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableEventValue(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(input);
}

function isKeyboardEventName(type: string): boolean {
  return type === "keydown" || type === "keyup";
}

function isPointerEventName(type: string): boolean {
  return type.startsWith("pointer");
}

function isDragEventName(type: string): boolean {
  return type === "dragstart" || type === "drag" || type === "dragend" || type === "drop";
}

function isInstance(target: unknown, constructorName: string): boolean {
  const ctor = globalThis[constructorName as keyof typeof globalThis];
  return typeof ctor === "function" && target instanceof ctor;
}
