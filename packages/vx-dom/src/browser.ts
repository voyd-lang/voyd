import { callComponentFn } from "./memory.js";
import { normalizeRenderFrame } from "./normalize.js";
import {
  listenerKey,
  normalizeBrowserEvent,
  toListenerOptions,
} from "./events.js";
import type {
  CallOptions,
  EventDescriptor,
  RetainedEventHandlerRegistry,
  VNode,
  VxAppRuntime,
  VxCommandEnvelope,
  VxElementNode,
  VxMessage,
  VxRenderFrame,
  VxRuntimeEnvelope,
  VxRuntimeErrorContext,
  VxRuntimeErrorHandler,
  VxRuntimeExecutionContext,
  VxRuntimeHostOptions,
  VxRuntimeMessage,
  VxRuntimeStep,
  VxSubscriptionDisposer,
  VxSubscriptionEnvelope,
  VoydComponentFn,
} from "./types.js";

export {
  createVoydVxAppRuntime,
} from "./app-runtime.js";
export type {
  CreateVoydVxAppRuntimeOptions,
  VoydVxAppHost,
  VoydVxAppRuntimeExports,
} from "./app-runtime.js";
export type {
  NormalizedEventPayload,
  VNode,
  VxAppRuntime,
  VxCommandEnvelope,
  VxCommandExecutor,
  VxRenderFrame,
  VxRuntimeExecutionContext,
  VxRuntimeEventMessage,
  VxRuntimeHostOptions,
  VxRuntimeMapMessage,
  VxRuntimeMessage,
  VxRuntimeSubscriptionMessage,
  VxRuntimeStep,
  VxSubscriptionDisposer,
  VxSubscriptionEnvelope,
  VxSubscriptionRunner,
} from "./types.js";

export type RenderOptions = {
  callOptions: CallOptions;
  handlers?: RetainedEventHandlerRegistry;
};

export type VxDomRenderer = {
  render(input: unknown): void;
  hydrate(input: unknown): void;
  dispose(): void;
  getSnapshot(): VxRenderFrame | undefined;
};

export type MountedVxApp = {
  dispatch(message: VxMessage): Promise<void>;
  render(): Promise<void>;
  dispose(): void;
  getSnapshot(): unknown;
};

export type MountVxAppOptions = {
  container: Element;
  componentFn?: VoydComponentFn;
  callOptions?: CallOptions;
  frame?: unknown;
  wasm?: Uint8Array | WebAssembly.Module;
  imports?: WebAssembly.Imports;
  instance?: WebAssembly.Instance;
  exportName?: string;
  handlers?: RetainedEventHandlerRegistry;
  app?: VxAppRuntime;
  runtimeHost?: VxRuntimeHostOptions;
  onError?: VxRuntimeErrorHandler;
  dispatch?: (message: VxMessage) => Promise<void> | void;
};

type ListenerRecord = {
  key: string;
  listener: EventListener;
  options: AddEventListenerOptions;
  handlerId: number;
};

type ActiveSubscription = {
  signature: string;
  dispose: VxSubscriptionDisposer;
};

const mapHandlerIdsProperty = "__vxMapHandlerIds";
const taskObserverProperty = Symbol.for("voyd.taskObserver");
const listenerState = new WeakMap<Element, Map<string, ListenerRecord>>();

type TaskRunOutcome =
  | { kind: "value"; value: unknown }
  | { kind: "failed"; error: Error }
  | { kind: "cancelled"; reason?: unknown };

type TaskObserver = (taskId: number) => Promise<TaskRunOutcome>;

export function createBrowserVxRuntimeHost(
  overrides: VxRuntimeHostOptions = {},
): VxRuntimeHostOptions {
  return {
    commands: {
      delay: runDelayCommand,
      focus: runFocusCommand,
      scroll_into_view: runScrollIntoViewCommand,
      task: runTaskCommand,
      ...overrides.commands,
    },
    subscriptions: {
      interval: runIntervalSubscription,
      keyboard: runKeyboardSubscription,
      ...overrides.subscriptions,
    },
    onError: overrides.onError,
  };
}

export function render(
  componentFn: VoydComponentFn,
  container: HTMLElement,
  options: RenderOptions,
): void {
  const tree = callComponentFn(componentFn, options.callOptions);
  renderMsgPackNode(tree, container, { handlers: options.handlers });
}

export function renderMsgPackNode(
  tree: unknown,
  container: Element,
  options: { handlers?: RetainedEventHandlerRegistry } = {},
): VxDomRenderer {
  const renderer = createVxDomRenderer(container, options);
  renderer.render(tree);
  return renderer;
}

export function createVxDomRenderer(
  container: Element,
  options: { handlers?: RetainedEventHandlerRegistry } = {},
): VxDomRenderer {
  let currentFrame: VxRenderFrame | undefined;
  let retainedHandlers = new Set<number>();

  const releaseRemovedHandlers = (next: Set<number>) => {
    const removed = Array.from(retainedHandlers).filter((id) => !next.has(id));
    if (removed.length === 0) {
      retainedHandlers = next;
      return;
    }
    if (options.handlers?.releaseMany) {
      options.handlers.releaseMany(removed);
    } else {
      removed.forEach((id) => options.handlers?.release?.(id));
    }
    retainedHandlers = next;
  };

  return {
    render(input: unknown) {
      const nextFrame = flattenRenderFrame(normalizeRenderFrame(input));
      const nextHandlers = collectHandlerIds(nextFrame.root);
      patchContainer(container, currentFrame?.root, nextFrame.root, options.handlers);
      releaseRemovedHandlers(nextHandlers);
      currentFrame = nextFrame;
    },
    hydrate(input: unknown) {
      const nextFrame = flattenRenderFrame(normalizeRenderFrame(input));
      const nextHandlers = collectHandlerIds(nextFrame.root);
      hydrateContainer(container, nextFrame.root, options.handlers);
      releaseRemovedHandlers(nextHandlers);
      currentFrame = nextFrame;
    },
    dispose() {
      removeContainerListeners(container);
      container.textContent = "";
      if (options.handlers?.releaseMany) {
        options.handlers.releaseMany(retainedHandlers);
      } else {
        retainedHandlers.forEach((id) => options.handlers?.release?.(id));
      }
      retainedHandlers = new Set();
      currentFrame = undefined;
    },
    getSnapshot() {
      return currentFrame;
    },
  };
}

export async function mountVxApp(options: MountVxAppOptions): Promise<MountedVxApp> {
  if (options.app) return mountRuntimeApp(options, "render");

  const instance = await resolveInstanceForMount(options);
  const exportName = options.exportName ?? "main";
  const renderer = createVxDomRenderer(options.container, { handlers: options.handlers });

  const renderNext = async () => {
    if (options.frame !== undefined) {
      renderer.render(options.frame);
      return;
    }
    const componentFn = options.componentFn ?? exportedComponent(requiredInstance(instance), exportName);
    const callOptions = options.callOptions ?? { instance: requiredInstance(instance) };
    renderer.render(callComponentFn(componentFn, callOptions));
  };

  await renderNext();

  return {
    dispatch: async (message) => {
      await options.dispatch?.(message);
      await renderNext();
    },
    render: renderNext,
    dispose: renderer.dispose,
    getSnapshot: renderer.getSnapshot,
  };
}

export async function hydrateVxApp(
  options: MountVxAppOptions & { hydrationData?: string | VxRenderFrame },
): Promise<MountedVxApp> {
  if (options.app) return mountRuntimeApp(options, "hydrate");

  const instance = await resolveInstanceForMount(options);
  const exportName = options.exportName ?? "main";
  const renderer = createVxDomRenderer(options.container, { handlers: options.handlers });

  const readFrame = () => {
    if (options.frame !== undefined) return options.frame;
    if (typeof options.hydrationData === "string") {
      return JSON.parse(options.hydrationData) as unknown;
    }
    if (options.hydrationData) return options.hydrationData;
    const componentFn = options.componentFn ?? exportedComponent(requiredInstance(instance), exportName);
    const callOptions = options.callOptions ?? { instance: requiredInstance(instance) };
    return callComponentFn(componentFn, callOptions);
  };

  renderer.hydrate(readFrame());

  return {
    dispatch: async (message) => {
      await options.dispatch?.(message);
      renderer.render(readFrame());
    },
    render: async () => renderer.render(readFrame()),
    dispose: renderer.dispose,
    getSnapshot: renderer.getSnapshot,
  };
}

async function mountRuntimeApp(
  options: MountVxAppOptions & { hydrationData?: string | VxRenderFrame },
  mode: "hydrate" | "render",
): Promise<MountedVxApp> {
  const app = options.app!;
  let disposed = false;
  let previousSubscriptions: unknown;
  const abortController = new AbortController();
  const activeSubscriptions = new Map<string, ActiveSubscription>();
  const runtimeHost = createBrowserVxRuntimeHost(options.runtimeHost);
  const reportError = createRuntimeErrorReporter(options.onError ?? runtimeHost.onError);
  let queue = Promise.resolve();

  const dispatchNow = async (message: VxRuntimeMessage): Promise<void> => {
    if (disposed) return;
    const result = await app.dispatch(message);
    await applyRuntimeStep(result);
  };

  const dispatchQueued = async (message: VxRuntimeMessage): Promise<void> => {
    const run = queue.catch(() => undefined).then(() => dispatchNow(message));
    queue = run.catch((error) => reportError(error, { phase: "dispatch", message }));
    await run;
  };
  const executionContext: VxRuntimeExecutionContext = {
    dispatch: dispatchQueued,
    reportError,
    signal: abortController.signal,
  };

  const runtimeHandlers: RetainedEventHandlerRegistry = {
    dispatch: (handlerId, payload) =>
      options.handlers?.dispatch?.(handlerId, payload) ??
      dispatchQueued({ kind: "event", handlerId, payload }),
    dispatchMapped: async (handlerId, payload, mapHandlerIds) => {
      if (!options.handlers?.dispatch) {
        await dispatchQueued(mapRuntimeMessage({ kind: "event", handlerId, payload }, mapHandlerIds));
        return;
      }
      const message = await options.handlers.dispatch(handlerId, payload);
      if (message !== undefined) {
        await dispatchQueued(mapRuntimeMessage(toRuntimeMessage(message), mapHandlerIds));
      }
    },
    dispatchMessage: (message) => dispatchQueued(toRuntimeMessage(message)),
    release: options.handlers?.release,
    releaseMany: options.handlers?.releaseMany,
  };
  const renderer = createVxDomRenderer(options.container, {
    handlers: runtimeHandlers,
  });

  const applyRuntimeStep = async (result: unknown, renderMode: "hydrate" | "render" = "render") => {
    if (disposed) return;
    const step = normalizeRuntimeStep(result);
    try {
      const frame = step.frame ?? (await app.render());
      if (renderMode === "hydrate") renderer.hydrate(frame);
      else renderer.render(frame);
    } catch (error) {
      reportError(error, { phase: "render" });
      throw error;
    }

    if (step.subscriptions !== undefined && app.syncSubscriptions) {
      const previous = previousSubscriptions;
      previousSubscriptions = step.subscriptions;
      try {
        await app.syncSubscriptions(step.subscriptions, {
          previous,
          dispatch: dispatchQueued,
        });
      } catch (error) {
        reportError(error, { phase: "subscriptions" });
        throw error;
      }
    } else if (step.subscriptions !== undefined) {
      try {
        await syncRuntimeSubscriptions(
          step.subscriptions,
          activeSubscriptions,
          runtimeHost,
          executionContext,
        );
      } catch (error) {
        reportError(error, { phase: "subscriptions" });
        throw error;
      }
    }

    try {
      await runCommands(step.commands, runtimeHost, executionContext);
    } catch (error) {
      reportError(error, { phase: "commands" });
      throw error;
    }
  };

  try {
    const initial = app.init
      ? await app.init()
      : initialHydrationFrame(options) ?? await app.render();
    await applyRuntimeStep(initial, mode);
  } catch (error) {
    reportError(error, { phase: "init" });
    throw error;
  }

  return {
    dispatch: (message) => dispatchQueued(message),
    render: async () => applyRuntimeStep(await app.render()),
    dispose() {
      disposed = true;
      abortController.abort();
      void disposeSubscriptions(activeSubscriptions).catch((error) => reportError(error, { phase: "dispose" }));
      renderer.dispose();
      void Promise.resolve(app.dispose?.()).catch((error) => reportError(error, { phase: "dispose" }));
    },
    getSnapshot() {
      return app.getSnapshot?.() ?? renderer.getSnapshot();
    },
  };
}

function patchContainer(
  container: Element,
  oldNode: VNode | undefined,
  newNode: VNode,
  handlers: RetainedEventHandlerRegistry | undefined,
): void {
  if (newNode.kind === "fragment") {
    const oldChildren = oldNode?.kind === "fragment" ? oldNode.children : [];
    patchChildren(container, oldChildren, newNode.children, handlers);
    return;
  }

  const current = container.firstChild;
  if (!current || !oldNode) {
    container.textContent = "";
    container.appendChild(createDom(newNode, handlers));
    return;
  }

  patchNode(container, current, oldNode, newNode, handlers);

  while (container.childNodes.length > 1) {
    removeDom(container.lastChild);
  }
}

function flattenRenderFrame(frame: VxRenderFrame): VxRenderFrame {
  return { ...frame, root: flattenVNode(frame.root) };
}

function flattenVNode(vnode: VNode): VNode {
  if (vnode.kind === "element") {
    return {
      ...vnode,
      children: flattenChildren(vnode.children ?? []),
    };
  }
  if (vnode.kind === "fragment") {
    return {
      ...vnode,
      children: flattenChildren(vnode.children),
    };
  }
  return vnode;
}

function flattenChildren(children: VNode[]): VNode[] {
  return children.flatMap((child) => {
    const flattened = flattenVNode(child);
    if (flattened.kind !== "fragment") return [flattened];
    if (flattened.key) {
      return flattened.children.map((fragmentChild, index) =>
        withVNodeKey(
          fragmentChild,
          flattened.children.length === 1
            ? flattened.key!
            : `${flattened.key}:${fragmentChild.key ?? index}`,
        ));
    }
    return flattened.children;
  });
}

function withVNodeKey(vnode: VNode, key: string): VNode {
  return { ...vnode, key };
}

function patchNode(
  parent: Node,
  dom: Node,
  oldNode: VNode,
  newNode: VNode,
  handlers: RetainedEventHandlerRegistry | undefined,
): Node {
  if (!sameNodeKind(oldNode, newNode)) {
    const nextDom = createDom(newNode, handlers);
    parent.replaceChild(nextDom, dom);
    removeDom(dom);
    return nextDom;
  }

  if (newNode.kind === "text") {
    if (dom.textContent !== newNode.value) dom.textContent = newNode.value;
    return dom;
  }

  if (newNode.kind === "fragment") {
    patchChildren(dom, oldNode.kind === "fragment" ? oldNode.children : [], newNode.children, handlers);
    return dom;
  }

  const element = dom as Element;
  const oldElement = oldNode as VxElementNode;
  applyElementProps(element, oldElement, newNode, handlers);
  patchChildren(element, oldElement.children ?? [], newNode.children ?? [], handlers);
  return element;
}

function createDom(
  vnode: VNode,
  handlers: RetainedEventHandlerRegistry | undefined,
): Node {
  if (vnode.kind === "text") return document.createTextNode(vnode.value);
  if (vnode.kind === "fragment") {
    const fragment = document.createDocumentFragment();
    vnode.children.forEach((child) => fragment.appendChild(createDom(child, handlers)));
    return fragment;
  }

  const element = document.createElement(vnode.tag);
  applyElementProps(element, undefined, vnode, handlers);
  (vnode.children ?? []).forEach((child) => element.appendChild(createDom(child, handlers)));
  return element;
}

function patchChildren(
  parent: Node,
  oldChildren: VNode[],
  newChildren: VNode[],
  handlers: RetainedEventHandlerRegistry | undefined,
): void {
  const oldKeyed = new Map<string, { vnode: VNode; dom: ChildNode }>();
  oldChildren.forEach((child, index) => {
    const key = child.key;
    const dom = parent.childNodes.item(index);
    if (key && dom) oldKeyed.set(key, { vnode: child, dom });
  });

  const usedDom = new Set<Node>();
  newChildren.forEach((newChild, index) => {
    const currentAtIndex = parent.childNodes.item(index);
    const keyed = newChild.key ? oldKeyed.get(newChild.key) : undefined;
    const oldChild = keyed?.vnode ?? oldChildren[index];
    const candidateDom = keyed?.dom ?? currentAtIndex;

    if (!candidateDom || !oldChild || usedDom.has(candidateDom)) {
      const nextDom = createDom(newChild, handlers);
      parent.insertBefore(nextDom, currentAtIndex ?? null);
      usedDom.add(nextDom);
      return;
    }

    const patched = patchNode(parent, candidateDom, oldChild, newChild, handlers);
    const desired = parent.childNodes.item(index);
    if (patched !== desired) parent.insertBefore(patched, desired ?? null);
    usedDom.add(patched);
  });

  Array.from(parent.childNodes).forEach((dom) => {
    if (!usedDom.has(dom)) removeDom(dom);
  });
}

function applyElementProps(
  element: Element,
  oldNode: VxElementNode | undefined,
  newNode: VxElementNode,
  handlers: RetainedEventHandlerRegistry | undefined,
): void {
  patchAttrs(element, oldNode?.attrs ?? {}, newNode.attrs ?? {});
  patchStyles(element as HTMLElement, oldNode?.styles ?? {}, newNode.styles ?? {});
  patchProps(element, oldNode?.props ?? {}, newNode.props ?? {});
  patchEvents(element, oldNode?.events ?? [], newNode.events ?? [], handlers);
}

function patchAttrs(
  element: Element,
  oldAttrs: Record<string, unknown>,
  newAttrs: Record<string, unknown>,
): void {
  Object.keys(oldAttrs).forEach((key) => {
    if (!(key in newAttrs)) element.removeAttribute(key);
  });
  Object.entries(newAttrs).forEach(([key, value]) => {
    if (key === "key" || value == null || value === false) {
      element.removeAttribute(key);
      return;
    }
    if (value === true) {
      element.setAttribute(key, "");
      return;
    }
    const next = String(value);
    if (element.getAttribute(key) !== next) element.setAttribute(key, next);
  });
}

function patchProps(
  element: Element,
  oldProps: Record<string, unknown>,
  newProps: Record<string, unknown>,
): void {
  Object.keys(oldProps).forEach((key) => {
    if (!(key in newProps)) setDomProperty(element, key, undefined);
  });
  Object.entries(newProps).forEach(([key, value]) => {
    setDomProperty(element, key, value);
  });
}

function patchStyles(
  element: HTMLElement,
  oldStyles: Record<string, string>,
  newStyles: Record<string, string>,
): void {
  Object.keys(oldStyles).forEach((key) => {
    if (!(key in newStyles)) element.style.removeProperty(key);
  });
  Object.entries(newStyles).forEach(([key, value]) => {
    if (element.style.getPropertyValue(key) !== value) {
      element.style.setProperty(key, value);
    }
  });
}

function patchEvents(
  element: Element,
  oldEvents: EventDescriptor[],
  newEvents: EventDescriptor[],
  handlers: RetainedEventHandlerRegistry | undefined,
): void {
  const current = listenerState.get(element) ?? new Map<string, ListenerRecord>();
  const nextKeys = new Set(newEvents.map(listenerKey));

  oldEvents.forEach((event) => {
    const key = listenerKey(event);
    if (nextKeys.has(key)) return;
    const record = current.get(key);
    if (!record) return;
    element.removeEventListener(event.event, record.listener, record.options);
    current.delete(key);
  });

  newEvents.forEach((event) => {
    const key = listenerKey(event);
    if (current.has(key)) return;
    const listener: EventListener = (browserEvent) => {
      if (event.options?.preventDefault) browserEvent.preventDefault();
      if (event.options?.stopPropagation) browserEvent.stopPropagation();
      if (typeof event.handlerId === "number") {
        if (event.mapHandlerIds?.length) {
          const payload = normalizeBrowserEvent(browserEvent);
          if (handlers?.dispatchMapped) {
            settleAsyncDispatch(handlers.dispatchMapped(event.handlerId, payload, event.mapHandlerIds));
            return;
          }
          settleAsyncDispatch(handlers?.dispatchMessage?.(
            mapRuntimeMessage({
              kind: "event",
              handlerId: event.handlerId,
              payload,
            }, event.mapHandlerIds),
          ));
          return;
        }
        void Promise.resolve(
          handlers?.dispatch(event.handlerId, normalizeBrowserEvent(browserEvent)),
        ).then((message) => {
          if (message !== undefined) {
            return handlers?.dispatchMessage?.(
              event.mapHandlerIds?.length
                ? mapRuntimeMessage(toVxMessage(message), event.mapHandlerIds)
                : message,
            );
          }
        }).catch(() => undefined);
        return;
      }
      if (Object.hasOwn(event, "message")) {
        const message = toVxMessage(event.message);
        settleAsyncDispatch(handlers?.dispatchMessage?.(
          event.mapHandlerIds?.length
            ? mapRuntimeMessage(message, event.mapHandlerIds)
            : event.message,
        ));
      }
    };
    const options = toListenerOptions(event.options);
    element.addEventListener(event.event, listener, options);
    current.set(key, { key, listener, options, handlerId: event.handlerId ?? -1 });
  });

  if (current.size > 0) {
    listenerState.set(element, current);
  } else {
    listenerState.delete(element);
  }
}

function hydrateContainer(
  container: Element,
  vnode: VNode,
  handlers: RetainedEventHandlerRegistry | undefined,
): void {
  if (vnode.kind === "fragment") {
    vnode.children.forEach((child, index) => {
      const domChild = container.childNodes.item(index);
      if (domChild) hydrateNode(domChild, child, handlers);
      else container.appendChild(createDom(child, handlers));
    });
    removeExtraChildren(container, vnode.children.length);
    return;
  }

  const current = container.firstChild;
  if (!current) {
    container.appendChild(createDom(vnode, handlers));
    return;
  }
  hydrateNode(current, vnode, handlers);
}

function hydrateNode(
  dom: Node,
  vnode: VNode,
  handlers: RetainedEventHandlerRegistry | undefined,
): void {
  if (vnode.kind === "text") {
    if (dom.textContent !== vnode.value) dom.textContent = vnode.value;
    return;
  }
  if (vnode.kind === "fragment") {
    vnode.children.forEach((child, index) => {
      const domChild = dom.childNodes.item(index);
      if (domChild) hydrateNode(domChild, child, handlers);
    });
    removeExtraChildren(dom, vnode.children.length);
    return;
  }
  if (!(dom instanceof Element) || dom.tagName.toLowerCase() !== vnode.tag) {
    dom.parentNode?.replaceChild(createDom(vnode, handlers), dom);
    return;
  }
  applyElementProps(dom, domElementSnapshot(dom), vnode, handlers);
  (vnode.children ?? []).forEach((child, index) => {
    const domChild = dom.childNodes.item(index);
    if (domChild) hydrateNode(domChild, child, handlers);
    else dom.appendChild(createDom(child, handlers));
  });
  removeExtraChildren(dom, vnode.children?.length ?? 0);
}

function domElementSnapshot(element: Element): VxElementNode {
  return {
    kind: "element",
    tag: element.tagName.toLowerCase(),
    attrs: currentAttrs(element),
    styles: currentStyles(element),
    props: {},
    events: [],
    children: [],
  };
}

function currentAttrs(element: Element): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  Array.from(element.attributes).forEach((attr) => {
    if (attr.name === "style") return;
    attrs[attr.name] = attr.value;
  });
  return attrs;
}

function currentStyles(element: Element): Record<string, string> {
  if (!(element instanceof HTMLElement)) return {};
  const styles: Record<string, string> = {};
  Array.from(element.style).forEach((name) => {
    styles[name] = element.style.getPropertyValue(name);
  });
  return styles;
}

function removeExtraChildren(parent: Node, expectedLength: number): void {
  while (parent.childNodes.length > expectedLength) {
    removeDom(parent.lastChild);
  }
}

function removeContainerListeners(container: Element): void {
  Array.from(container.querySelectorAll("*")).forEach(removeElementListeners);
  removeElementListeners(container);
}

function removeElementListeners(element: Element): void {
  const records = listenerState.get(element);
  if (!records) return;
  records.forEach((record) => {
    element.removeEventListener(record.key.split(":")[0] ?? "", record.listener, record.options);
  });
  listenerState.delete(element);
}

function removeDom(dom: Node | null): void {
  if (!dom) return;
  if (dom instanceof Element) {
    removeContainerListeners(dom);
  }
  dom.parentNode?.removeChild(dom);
}

function collectHandlerIds(vnode: VNode): Set<number> {
  const ids = new Set<number>();
  const visit = (node: VNode) => {
    if (node.kind === "element") {
      (node.events ?? []).forEach((event) => {
        if (typeof event.handlerId === "number") ids.add(event.handlerId);
        event.mapHandlerIds?.forEach((handlerId) => ids.add(handlerId));
      });
      (node.children ?? []).forEach(visit);
      return;
    }
    if (node.kind === "fragment") node.children.forEach(visit);
  };
  visit(vnode);
  return ids;
}

function sameNodeKind(oldNode: VNode, newNode: VNode): boolean {
  if (oldNode.kind !== newNode.kind) return false;
  if (oldNode.kind === "element" && newNode.kind === "element") {
    return oldNode.tag === newNode.tag;
  }
  return true;
}

function setDomProperty(element: Element, key: string, value: unknown): void {
  const target = element as Element & Record<string, unknown>;
  const next = value ?? "";
  if (target[key] !== next) target[key] = next;
}

async function runCommands(
  input: unknown,
  host: VxRuntimeHostOptions | undefined,
  context: VxRuntimeExecutionContext,
  taskObserver?: TaskObserver,
): Promise<void> {
  if (input === undefined || input === null) return;
  if (Array.isArray(input)) {
    for (const child of input) await runCommands(child, host, context, taskObserver);
    return;
  }
  const commandEnvelope = readRuntimeEnvelope(input, "cmd", "commands");

  const nextTaskObserver = readTaskObserver(commandEnvelope) ?? taskObserver;
  if (commandEnvelope.kind === "none") return;
  if (commandEnvelope.kind === "message") {
    if (!Object.hasOwn(commandEnvelope, "value")) {
      throw new Error("vx-dom: command message missing required value");
    }
    await context.dispatch(toVxMessage(commandEnvelope.value));
    return;
  }
  if (commandEnvelope.kind === "batch") {
    if (!Object.hasOwn(commandEnvelope, "children")) {
      throw new Error("vx-dom: command batch missing required children");
    }
    await runCommands(commandEnvelope.children, host, context, nextTaskObserver);
    return;
  }
  if (commandEnvelope.kind === "map") {
    const handlerId = readHandlerId(commandEnvelope);
    if (handlerId === undefined) throw new Error("vx-dom: command map missing numeric handlerId");
    const child = readRequiredMappedChild(commandEnvelope, "command map");
    await runCommands(
      child,
      host,
      mapExecutionContext(context, handlerId),
      nextTaskObserver,
    );
    return;
  }
  const command = nextTaskObserver
    ? attachTaskObserver(commandEnvelope, nextTaskObserver)
    : commandEnvelope;
  const executor = host?.commands?.[commandEnvelope.kind];
  if (!executor) throw new Error(`vx-dom: no runtime command handler registered for "${commandEnvelope.kind}"`);
  await executor(command, context);
}

function runDelayCommand(
  command: VxCommandEnvelope,
  context: VxRuntimeExecutionContext,
): void {
  const ms = readMillis(command);
  if (ms === undefined) throw new Error("vx-dom: delay command missing non-negative millis");
  if (!Object.hasOwn(command, "value")) throw new Error("vx-dom: delay command missing value");
  const timeout = setTimeout(() => {
    if (context.signal.aborted) return;
    settleAsyncDispatch(context.dispatch(toVxMessage(command.value)));
  }, ms);
  context.signal.addEventListener("abort", () => clearTimeout(timeout), { once: true });
}

function runTaskCommand(
  command: VxCommandEnvelope,
  context: VxRuntimeExecutionContext,
): void {
  const taskId = readTaskId(command);
  const observeTask = readTaskObserver(command);
  if (taskId === undefined) throw new Error("vx-dom: task command missing numeric taskId");
  if (!observeTask) throw new Error("vx-dom: task command requires task runtime support");

  void observeTask(taskId).then((outcome) => {
    if (context.signal.aborted) return;
    if (outcome.kind === "failed") {
      context.reportError?.(outcome.error, { phase: "commands" });
      return;
    }
    if (outcome.kind !== "value") return;
    const handlerId = readHandlerId(command);
    const message = toVxMessage(outcome.value);
    return context.dispatch(
      handlerId === undefined
        ? message
        : { kind: "map", handlerId, message },
    );
  }).catch((error) => {
    context.reportError?.(error, { phase: "commands" });
  });
}

function runFocusCommand(command: VxCommandEnvelope): void {
  if (typeof command.value !== "string") throw new Error("vx-dom: focus command missing string value");
  const target = findRefElement(command.value);
  if (target instanceof HTMLElement) target.focus();
}

function runScrollIntoViewCommand(command: VxCommandEnvelope): void {
  if (typeof command.value !== "string") throw new Error("vx-dom: scroll_into_view command missing string value");
  const target = findRefElement(command.value);
  if (typeof target?.scrollIntoView === "function") target.scrollIntoView();
}

function runIntervalSubscription(
  subscription: VxSubscriptionEnvelope,
  context: VxRuntimeExecutionContext,
): VxSubscriptionDisposer | void {
  const ms = readMillis(subscription);
  if (ms === undefined) throw new Error("vx-dom: interval subscription missing non-negative millis");
  if (!Object.hasOwn(subscription, "value")) throw new Error("vx-dom: interval subscription missing value");
  const interval = setInterval(() => {
    if (context.signal.aborted) return;
    settleAsyncDispatch(context.dispatch(toVxMessage(subscription.value)));
  }, ms);
  return () => clearInterval(interval);
}

function runKeyboardSubscription(
  subscription: VxSubscriptionEnvelope,
  context: VxRuntimeExecutionContext,
): VxSubscriptionDisposer | void {
  if (!Object.hasOwn(subscription, "value")) throw new Error("vx-dom: keyboard subscription missing value");
  const eventName = typeof subscription.event === "string"
    ? subscription.event
    : "keydown";
  if (typeof window === "undefined") return;
  const listener: EventListener = (event) => {
    if (context.signal.aborted) return;
    const subscribedKey = optionalSubscriptionKey(subscription);
    if (subscribedKey && isKeyboardEvent(event) && event.key !== subscribedKey) return;
    settleAsyncDispatch(context.dispatch({
      kind: "subscription",
      subscriptionKind: "keyboard",
      key: subscribedKey,
      value: subscription.value,
      payload: normalizeBrowserEvent(event),
    }));
  };
  window.addEventListener(eventName, listener);
  return () => window.removeEventListener(eventName, listener);
}

async function syncRuntimeSubscriptions(
  input: unknown,
  active: Map<string, ActiveSubscription>,
  host: VxRuntimeHostOptions | undefined,
  context: VxRuntimeExecutionContext,
): Promise<void> {
  const next = flattenSubscriptions(input);
  const nextKeys = new Set(next.map(subscriptionIdentityKey));

  for (const [key, record] of active) {
    if (nextKeys.has(key)) continue;
    await record.dispose();
    active.delete(key);
  }

  for (const subscription of next) {
    const key = subscriptionIdentityKey(subscription);
    const signature = subscriptionSignature(subscription);
    const previous = active.get(key);
    if (previous?.signature === signature) continue;
    if (previous) {
      await previous.dispose();
      active.delete(key);
    }
    const runner = host?.subscriptions?.[subscription.kind];
    if (!runner) throw new Error(`vx-dom: no runtime subscription handler registered for "${subscription.kind}"`);
    const dispose = await runner(subscription, mapSubscriptionContext(subscription, context));
    active.set(key, { signature, dispose: dispose ?? (() => undefined) });
  }
}

async function disposeSubscriptions(
  active: Map<string, ActiveSubscription>,
): Promise<void> {
  const disposers = Array.from(active.values()).map((record) => record.dispose);
  active.clear();
  for (const dispose of disposers) await dispose();
}

function flattenSubscriptions(
  input: unknown,
  mapHandlerIds: number[] = [],
): VxSubscriptionEnvelope[] {
  if (input === undefined || input === null) return [];
  if (Array.isArray(input)) {
    return input.flatMap((child) => flattenSubscriptions(child, mapHandlerIds));
  }
  const envelope = readRuntimeEnvelope(input, "sub", "subscriptions");
  if (envelope.kind === "none") return [];
  if (envelope.kind === "batch") {
    if (!Object.hasOwn(envelope, "children")) {
      throw new Error("vx-dom: subscription batch missing required children");
    }
    return flattenSubscriptions(envelope.children, mapHandlerIds);
  }
  if (envelope.kind === "map") {
    const handlerId = readHandlerId(envelope);
    if (handlerId === undefined) throw new Error("vx-dom: subscription map missing numeric handlerId");
    return flattenSubscriptions(readRequiredMappedChild(envelope, "subscription map"), [...mapHandlerIds, handlerId]);
  }
  if (!optionalSubscriptionKey(envelope)) {
    throw new Error(`vx-dom: subscription "${envelope.kind}" requires a stable key`);
  }
  if (mapHandlerIds.length === 0) return [envelope];
  return [{ ...envelope, [mapHandlerIdsProperty]: mapHandlerIds }];
}

function subscriptionIdentityKey(subscription: VxSubscriptionEnvelope): string {
  const mapPrefix = mappedHandlerIds(subscription)
    .map((id) => `map:${id}`)
    .join("/");
  const explicitKey = subscription.key ?? subscription.id;
  const base = `${subscription.kind}:${String(explicitKey)}`;
  return mapPrefix ? `${mapPrefix}|${base}` : base;
}

function subscriptionSignature(subscription: VxSubscriptionEnvelope): string {
  return stableStringify(subscription);
}

function optionalSubscriptionKey(subscription: VxSubscriptionEnvelope): string | undefined {
  const key = subscription.key ?? subscription.id;
  return typeof key === "string" || typeof key === "number" ? String(key) : undefined;
}

function isKeyboardEvent(event: Event): event is KeyboardEvent {
  return typeof KeyboardEvent !== "undefined" && event instanceof KeyboardEvent;
}

function stableStringify(input: unknown): string {
  if (Array.isArray(input)) return `[${input.map(stableStringify).join(",")}]`;
  if (typeof input === "bigint") return `${input}n`;
  if (!isRecord(input)) return JSON.stringify(input);
  const entries = Object.keys(input)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(input[key])}`);
  return `{${entries.join(",")}}`;
}

function isRuntimeEnvelope<T extends VxRuntimeEnvelope["type"]>(
  input: unknown,
  type: T,
): input is T extends "cmd" ? VxCommandEnvelope : VxSubscriptionEnvelope {
  return isRecord(input) && input.type === type && typeof input.kind === "string";
}

function readRuntimeEnvelope<T extends VxRuntimeEnvelope["type"]>(
  input: unknown,
  type: T,
  path: string,
): T extends "cmd" ? VxCommandEnvelope : VxSubscriptionEnvelope {
  if (!isRuntimeEnvelope(input, type)) {
    throw new Error(`vx-dom: invalid ${type === "cmd" ? "command" : "subscription"} envelope at ${path}`);
  }
  return input as T extends "cmd" ? VxCommandEnvelope : VxSubscriptionEnvelope;
}

function readMillis(input: Record<string, unknown>): number | undefined {
  const raw = input.ms ?? input.millis ?? input.delay;
  if (typeof raw === "bigint") {
    if (raw < 0n || raw > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    return Number(raw);
  }
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return undefined;
  return raw;
}

function mapExecutionContext(
  context: VxRuntimeExecutionContext,
  handlerId: number,
): VxRuntimeExecutionContext {
  return {
    signal: context.signal,
    reportError: context.reportError,
    dispatch: (message) => context.dispatch({ kind: "map", handlerId, message }),
  };
}

function mapSubscriptionContext(
  subscription: VxSubscriptionEnvelope,
  context: VxRuntimeExecutionContext,
): VxRuntimeExecutionContext {
  return mappedHandlerIds(subscription).reduce(
    (next, handlerId) => mapExecutionContext(next, handlerId),
    context,
  );
}

function mappedHandlerIds(subscription: VxSubscriptionEnvelope): number[] {
  const raw = subscription[mapHandlerIdsProperty];
  return Array.isArray(raw) ? raw.filter((id): id is number => typeof id === "number") : [];
}

function readHandlerId(input: Record<string, unknown>): number | undefined {
  return typeof input.handlerId === "number"
    ? input.handlerId
    : typeof input.handler_id === "number"
      ? input.handler_id
      : undefined;
}

function readTaskId(input: Record<string, unknown>): number | undefined {
  return typeof input.taskId === "number"
    ? input.taskId
    : typeof input.task_id === "number"
      ? input.task_id
      : undefined;
}

function readTaskObserver(input: unknown): TaskObserver | undefined {
  if (!isRecord(input)) return undefined;
  const observer = input[taskObserverProperty];
  return typeof observer === "function" ? observer as TaskObserver : undefined;
}

function attachTaskObserver(
  input: VxCommandEnvelope,
  observer: TaskObserver,
): VxCommandEnvelope {
  if (readTaskObserver(input) === observer) return input;
  Object.defineProperty(input, taskObserverProperty, {
    configurable: true,
    enumerable: false,
    value: observer,
  });
  return input;
}

function readMappedChild(input: Record<string, unknown>): unknown {
  return input.child ?? input.command ?? input.subscription;
}

function readRequiredMappedChild(input: Record<string, unknown>, label: string): unknown {
  const child = readMappedChild(input);
  if (child === undefined) throw new Error(`vx-dom: ${label} missing required child`);
  return child;
}

function findRefElement(value: unknown): Element | undefined {
  if (typeof document === "undefined" || typeof value !== "string") return undefined;
  const refs = Array.from(document.querySelectorAll("[data-vx-ref]"));
  return refs.find((element) => element.getAttribute("data-vx-ref") === value)
    ?? document.getElementById(value)
    ?? undefined;
}

function normalizeRuntimeStep(input: unknown): VxRuntimeStep {
  if (!isRecord(input)) return { frame: input };
  if (
    "frame" in input ||
    "commands" in input ||
    "subscriptions" in input ||
    "snapshot" in input
  ) {
    return input as VxRuntimeStep;
  }
  return { frame: input };
}

function toRuntimeMessage(input: unknown): VxRuntimeMessage {
  if (isRecord(input) && input.kind === "event" && typeof input.handlerId === "number") {
    return input as VxRuntimeMessage;
  }
  if (isRecord(input) && input.kind === "subscription" && typeof input.subscriptionKind === "string") {
    return input as VxRuntimeMessage;
  }
  if (isRecord(input) && input.kind === "map" && typeof input.handlerId === "number") {
    return input as VxRuntimeMessage;
  }
  return toVxMessage(input);
}

function toVxMessage(input: unknown): VxMessage {
  if (isRecord(input) && input.kind === "debug" && typeof input.name === "string") {
    return input as VxMessage;
  }
  if (isRecord(input) && input.kind === "msgpack") {
    return input as VxMessage;
  }
  return { kind: "msgpack", value: input };
}

function mapRuntimeMessage(message: VxRuntimeMessage, handlerIds: readonly number[]): VxRuntimeMessage {
  return handlerIds.reduce<VxRuntimeMessage>(
    (child, handlerId) => ({ kind: "map", handlerId, message: child }),
    message,
  );
}

function settleAsyncDispatch(result: Promise<unknown> | unknown): void {
  void Promise.resolve(result).catch(() => undefined);
}

function initialHydrationFrame(
  options: { hydrationData?: string | VxRenderFrame },
): unknown {
  if (typeof options.hydrationData === "string") {
    return JSON.parse(options.hydrationData) as unknown;
  }
  return options.hydrationData;
}

function createRuntimeErrorReporter(
  onError: VxRuntimeErrorHandler | undefined,
): VxRuntimeErrorHandler {
  return (error: unknown, context: VxRuntimeErrorContext) => {
    onError?.(error, context);
  };
}

async function resolveInstanceForMount(
  options: Pick<MountVxAppOptions, "componentFn" | "frame" | "instance" | "wasm" | "imports">,
): Promise<WebAssembly.Instance | undefined> {
  if (options.instance) return options.instance;
  if (options.frame !== undefined || options.componentFn) return undefined;
  return instantiateWasm(options);
}

function requiredInstance(instance: WebAssembly.Instance | undefined): WebAssembly.Instance {
  if (instance) return instance;
  throw new Error("vx-dom: mountVxApp requires callOptions, an instance, wasm, frame, app, or componentFn");
}

function isRecord(input: unknown): input is Record<PropertyKey, unknown> {
  return typeof input === "object" && input !== null;
}

async function instantiateWasm(
  options: Pick<MountVxAppOptions, "wasm" | "imports" | "instance">,
): Promise<WebAssembly.Instance> {
  if (options.instance) return options.instance;
  if (!options.wasm) {
    throw new Error("vx-dom: mountVxApp requires an instance, wasm, frame, or componentFn");
  }
  if (options.wasm instanceof WebAssembly.Module) {
    return WebAssembly.instantiate(options.wasm, options.imports ?? {});
  }
  const result = (await WebAssembly.instantiate(
    options.wasm as BufferSource,
    options.imports ?? {},
  )) as WebAssembly.WebAssemblyInstantiatedSource;
  return result.instance;
}

function exportedComponent(
  instance: WebAssembly.Instance,
  exportName: string,
): VoydComponentFn {
  const entry = instance.exports[exportName];
  if (typeof entry !== "function") {
    throw new Error(`vx-dom: WebAssembly export ${exportName} is not a function`);
  }
  return entry as VoydComponentFn;
}
