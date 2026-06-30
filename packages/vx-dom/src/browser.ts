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
  VxRuntimeSubscriptionMessage,
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
  mapHandlerIds: number[];
  ownedMapHandlerIds: number[];
  setMapHandlerIds: (ids: number[]) => void;
};

type RetainedHandlerReleaser = Pick<RetainedEventHandlerRegistry, "release" | "releaseMany">;

const mapHandlerIdsProperty = "__vxMapHandlerIds";
const mapHandlerKeysProperty = "__vxMapHandlerKeys";
const ownedMapHandlerIdsProperty = "__vxOwnedMapHandlerIds";
const mapHandlerIdentityProperty = "__vxMapHandlerIdentity";
const taskObserverProperty = Symbol.for("voyd.taskObserver");
const locationChangeEvent = "vxlocationchange";
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
      copy_to_clipboard: runCopyToClipboardCommand,
      delay: runDelayCommand,
      focus: runFocusCommand,
      local_storage_clear: runLocalStorageClearCommand,
      local_storage_remove: runLocalStorageRemoveCommand,
      local_storage_set: runLocalStorageSetCommand,
      navigate_back: runNavigateBackCommand,
      navigate_forward: runNavigateForwardCommand,
      open_url: runOpenUrlCommand,
      push_url: runPushUrlCommand,
      read_clipboard: runReadClipboardCommand,
      replace_url: runReplaceUrlCommand,
      scroll_into_view: runScrollIntoViewCommand,
      scroll_window_by: runScrollWindowByCommand,
      scroll_window_to: runScrollWindowToCommand,
      select_text: runSelectTextCommand,
      session_storage_clear: runSessionStorageClearCommand,
      session_storage_remove: runSessionStorageRemoveCommand,
      session_storage_set: runSessionStorageSetCommand,
      set_hash: runSetHashCommand,
      set_document_title: runSetDocumentTitleCommand,
      task: runTaskCommand,
      ...overrides.commands,
    },
    subscriptions: {
      animation_frame: runAnimationFrameSubscription,
      broadcast_channel: runBroadcastChannelSubscription,
      interval: runIntervalSubscription,
      keyboard: runKeyboardSubscription,
      location_change: runLocationChangeSubscription,
      media_query: runMediaQuerySubscription,
      online_status: runOnlineStatusSubscription,
      storage: runStorageSubscription,
      visibility_change: runVisibilityChangeSubscription,
      window_blur: runWindowEventSubscription,
      window_focus: runWindowEventSubscription,
      window_resize: runWindowResizeSubscription,
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
  const retainedHandlerReleaser = retainedHandlerReleaserFor(app, options.handlers);
  const afterCommandCallbacks: Array<Array<() => void>> = [];
  let queue = Promise.resolve();
  const queuedRetainedHandlerReleaser: RetainedHandlerReleaser = {
    release: (id) => {
      void queue.catch(() => undefined).then(() => {
        if (retainedHandlerReleaser.release) {
          retainedHandlerReleaser.release(id);
          return;
        }
        retainedHandlerReleaser.releaseMany?.([id]);
      });
    },
    releaseMany: (ids) => {
      const retainedIds = Array.from(ids);
      void queue.catch(() => undefined).then(() => {
        if (retainedHandlerReleaser.releaseMany) {
          retainedHandlerReleaser.releaseMany(retainedIds);
          return;
        }
        retainedIds.forEach((id) => retainedHandlerReleaser.release?.(id));
      });
    },
  };

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
    deferAfterCommands: (callback) => {
      const callbacks = afterCommandCallbacks.at(-1);
      if (callbacks) {
        callbacks.push(callback);
        return;
      }
      callback();
    },
    releaseRetainedHandler: (id) => queuedRetainedHandlerReleaser.release?.(id),
    reportError,
    signal: abortController.signal,
  };

  const runtimeHandlers: RetainedEventHandlerRegistry = {
    dispatch: (handlerId, payload) =>
      options.handlers?.dispatch?.(handlerId, payload) ??
      dispatchQueued({ kind: "event", handlerId, payload }),
    dispatchMapped: async (handlerId, payload, mapHandlerIds) => {
      if (!options.handlers?.dispatch) {
        await dispatchQueued(mapDomEventMessage({ kind: "event", handlerId, payload }, mapHandlerIds));
        return;
      }
      const message = await options.handlers.dispatch(handlerId, payload);
      if (message !== undefined) {
        await dispatchQueued(mapDomEventMessage(toRuntimeMessage(message), mapHandlerIds));
      }
    },
    dispatchMessage: (message) => dispatchQueued(toRuntimeMessage(message)),
    release: queuedRetainedHandlerReleaser.release,
    releaseMany: queuedRetainedHandlerReleaser.releaseMany,
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

    const deferredCallbacks: Array<() => void> = [];
    afterCommandCallbacks.push(deferredCallbacks);
    let commandPhaseStarted = false;
    try {
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
            queuedRetainedHandlerReleaser,
          );
        } catch (error) {
          reportError(error, { phase: "subscriptions" });
          throw error;
        }
      }

      commandPhaseStarted = true;
      await runCommands(step.commands, runtimeHost, executionContext);
    } catch (error) {
      if (commandPhaseStarted) reportError(error, { phase: "commands" });
      throw error;
    } finally {
      afterCommandCallbacks.pop();
    }
    deferredCallbacks.forEach((callback) => callback());
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
      void disposeSubscriptions(activeSubscriptions, retainedHandlerReleaser)
        .catch((error) => reportError(error, { phase: "dispose" }));
      renderer.dispose();
      void Promise.resolve(app.dispose?.()).catch((error) => reportError(error, { phase: "dispose" }));
    },
    getSnapshot() {
      return app.getSnapshot?.() ?? renderer.getSnapshot();
    },
  };
}

function retainedHandlerReleaserFor(
  app: VxAppRuntime,
  handlers: RetainedEventHandlerRegistry | undefined,
): RetainedHandlerReleaser {
  if (app.retainedCallbacks?.release || app.retainedCallbacks?.releaseMany) {
    return {
      release: app.retainedCallbacks.release,
      releaseMany: app.retainedCallbacks.releaseMany,
    };
  }
  return {
    release: handlers?.release,
    releaseMany: handlers?.releaseMany,
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
            mapDomEventMessage({
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
                ? mapDomEventMessage(toVxMessage(message), event.mapHandlerIds)
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
            ? mapDomEventMessage(message, event.mapHandlerIds)
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
    const mapped = ownedCommandMapExecutionContext(
      context,
      handlerId,
      mappedOwnedHandlerIds(commandEnvelope),
    );
    try {
      await runCommands(
        child,
        host,
        mapped.context,
        nextTaskObserver,
      );
    } finally {
      mapped.finish();
    }
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
  let resolveCompletion: () => void = () => undefined;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  const timeout = setTimeout(() => {
    if (context.signal.aborted) {
      resolveCompletion();
      return;
    }
    Promise.resolve(context.dispatch(toVxMessage(command.value))).then(resolveCompletion, resolveCompletion);
  }, ms);
  context.signal.addEventListener("abort", () => {
    clearTimeout(timeout);
    resolveCompletion();
  }, { once: true });
  context.trackRetainedHandlerUse?.(completion);
  settleAsyncDispatch(completion);
}

function runTaskCommand(
  command: VxCommandEnvelope,
  context: VxRuntimeExecutionContext,
): void {
  const taskId = readTaskId(command);
  const observeTask = readTaskObserver(command);
  if (taskId === undefined) throw new Error("vx-dom: task command missing numeric taskId");
  if (!observeTask) throw new Error("vx-dom: task command requires task runtime support");

  const ownedHandlerIds = mappedOwnedHandlerIds(command);
  let released = false;
  const releaseOwnedHandlers = () => {
    if (released) return;
    released = true;
    ownedHandlerIds.forEach((id) => context.releaseRetainedHandler?.(id));
  };
  let resolveAbort: () => void = () => undefined;
  const abortCompletion = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });
  const abortListener = () => {
    releaseOwnedHandlers();
    resolveAbort();
  };
  context.signal.addEventListener("abort", abortListener, { once: true });

  const completion = observeTask(taskId).then((outcome) => {
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
  }).finally(() => {
    context.signal.removeEventListener("abort", abortListener);
    releaseOwnedHandlers();
    resolveAbort();
  });
  context.trackRetainedHandlerUse?.(Promise.race([completion, abortCompletion]));
  settleAsyncDispatch(completion);
}

async function runCopyToClipboardCommand(command: VxCommandEnvelope): Promise<void> {
  const value = readRequiredStringValue(command, "copy_to_clipboard");
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!clipboard || typeof clipboard.writeText !== "function") {
    throw new Error("vx-dom: copy_to_clipboard command requires navigator.clipboard.writeText");
  }
  await clipboard.writeText(value);
}

function runLocalStorageClearCommand(): void {
  readBrowserStorage("local_storage_clear", "local").clear();
}

function runLocalStorageRemoveCommand(command: VxCommandEnvelope): void {
  readBrowserStorage("local_storage_remove", "local").removeItem(
    readRequiredStringValue(command, "local_storage_remove"),
  );
}

function runLocalStorageSetCommand(command: VxCommandEnvelope): void {
  const entry = readStorageEntry(command, "local_storage_set");
  readBrowserStorage("local_storage_set", "local").setItem(entry.key, entry.value);
}

function runFocusCommand(command: VxCommandEnvelope): void {
  const target = findRefElement(readRequiredStringValue(command, "focus"));
  if (target instanceof HTMLElement) target.focus();
}

function runNavigateBackCommand(): void {
  if (typeof history !== "undefined") history.back();
}

function runNavigateForwardCommand(): void {
  if (typeof history !== "undefined") history.forward();
}

function runOpenUrlCommand(command: VxCommandEnvelope): void {
  const target = readOpenUrlTarget(command);
  if (typeof window !== "undefined" && typeof window.open === "function") {
    window.open(target.url, target.target);
  }
}

function runPushUrlCommand(command: VxCommandEnvelope): void {
  const value = readRequiredStringValue(command, "push_url");
  if (typeof history !== "undefined") {
    history.pushState(null, "", value);
    dispatchLocationChange();
  }
}

async function runReadClipboardCommand(
  command: VxCommandEnvelope,
  context: VxRuntimeExecutionContext,
): Promise<void> {
  const handlerId = readHandlerId(command);
  if (handlerId === undefined) {
    throw new Error("vx-dom: read_clipboard command missing numeric handlerId");
  }
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!clipboard || typeof clipboard.readText !== "function") {
    throw new Error("vx-dom: read_clipboard command requires navigator.clipboard.readText");
  }
  try {
    const value = await clipboard.readText();
    if (context.signal.aborted) return;
    settleAsyncDispatch(context.dispatch({ kind: "map", handlerId, message: toVxMessage(value) }));
  } finally {
    mappedOwnedHandlerIds(command).forEach((id) => context.releaseRetainedHandler?.(id));
  }
}

function runReplaceUrlCommand(command: VxCommandEnvelope): void {
  const value = readRequiredStringValue(command, "replace_url");
  if (typeof history !== "undefined") {
    history.replaceState(null, "", value);
    dispatchLocationChange();
  }
}

function runScrollIntoViewCommand(command: VxCommandEnvelope): void {
  const target = findRefElement(readRequiredStringValue(command, "scroll_into_view"));
  if (typeof target?.scrollIntoView === "function") target.scrollIntoView();
}

function runScrollWindowByCommand(command: VxCommandEnvelope): void {
  const point = readPointValue(command, "scroll_window_by");
  if (typeof window !== "undefined" && typeof window.scrollBy === "function") {
    window.scrollBy(point.x, point.y);
  }
}

function runScrollWindowToCommand(command: VxCommandEnvelope): void {
  const point = readPointValue(command, "scroll_window_to");
  if (typeof window !== "undefined" && typeof window.scrollTo === "function") {
    window.scrollTo(point.x, point.y);
  }
}

function runSelectTextCommand(command: VxCommandEnvelope): void {
  const target = findRefElement(readRequiredStringValue(command, "select_text"));
  if (target && "select" in target && typeof target.select === "function") {
    target.select();
  }
}

function runSessionStorageClearCommand(): void {
  readBrowserStorage("session_storage_clear", "session").clear();
}

function runSessionStorageRemoveCommand(command: VxCommandEnvelope): void {
  readBrowserStorage("session_storage_remove", "session").removeItem(
    readRequiredStringValue(command, "session_storage_remove"),
  );
}

function runSessionStorageSetCommand(command: VxCommandEnvelope): void {
  const entry = readStorageEntry(command, "session_storage_set");
  readBrowserStorage("session_storage_set", "session").setItem(entry.key, entry.value);
}

function runSetHashCommand(command: VxCommandEnvelope): void {
  const value = readRequiredStringValue(command, "set_hash");
  if (typeof location !== "undefined") location.hash = value;
}

function runSetDocumentTitleCommand(command: VxCommandEnvelope): void {
  const value = readRequiredStringValue(command, "set_document_title");
  if (typeof document !== "undefined") document.title = value;
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
  const eventName = typeof subscription.event === "string"
    ? subscription.event
    : "keydown";
  if (typeof window === "undefined") return;
  const listener: EventListener = (event) => {
    if (context.signal.aborted) return;
    const subscribedKey = optionalSubscriptionKey(subscription);
    if (subscribedKey && isKeyboardEvent(event) && event.key !== subscribedKey) return;
    settleAsyncDispatch(context.dispatch(subscriptionMessage(
      subscription,
      normalizeBrowserEvent(event),
    )));
  };
  window.addEventListener(eventName, listener);
  return () => window.removeEventListener(eventName, listener);
}

function runAnimationFrameSubscription(
  subscription: VxSubscriptionEnvelope,
  context: VxRuntimeExecutionContext,
): VxSubscriptionDisposer | void {
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") return;
  let frameId: number | undefined;
  const tick = (timestamp: number) => {
    if (context.signal.aborted) return;
    settleAsyncDispatch(context.dispatch(subscriptionMessage(subscription, {
      kind: "animation_frame",
      timestamp,
    })));
    frameId = window.requestAnimationFrame(tick);
  };
  frameId = window.requestAnimationFrame(tick);
  return () => {
    if (frameId !== undefined && typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(frameId);
    }
  };
}

function runBroadcastChannelSubscription(
  subscription: VxSubscriptionEnvelope,
  context: VxRuntimeExecutionContext,
): VxSubscriptionDisposer | void {
  const channelName = readRequiredStringField(subscription, "name", "broadcast_channel subscription");
  if (typeof BroadcastChannel === "undefined") {
    throw new Error("vx-dom: broadcast_channel subscription requires BroadcastChannel");
  }
  const channel = new BroadcastChannel(channelName);
  const listener = (event: MessageEvent) => {
    if (context.signal.aborted) return;
    settleAsyncDispatch(context.dispatch(subscriptionMessage(subscription, event.data)));
  };
  channel.addEventListener("message", listener);
  return () => {
    channel.removeEventListener("message", listener);
    channel.close();
  };
}

function runLocationChangeSubscription(
  subscription: VxSubscriptionEnvelope,
  context: VxRuntimeExecutionContext,
): VxSubscriptionDisposer | void {
  if (typeof window === "undefined") return;
  let observedChange = false;
  const dispatch = () => {
    if (context.signal.aborted) return;
    settleAsyncDispatch(context.dispatch(subscriptionMessage(subscription, locationPayload())));
  };
  const dispatchObserved = () => {
    observedChange = true;
    dispatch();
  };
  const dispatchInitial = () => {
    if (!observedChange) dispatch();
  };
  window.addEventListener("popstate", dispatchObserved);
  window.addEventListener("hashchange", dispatchObserved);
  window.addEventListener(locationChangeEvent, dispatchObserved);
  if (context.deferAfterCommands) {
    context.deferAfterCommands(dispatchInitial);
  } else {
    setTimeout(dispatchInitial, 0);
  }
  return () => {
    window.removeEventListener("popstate", dispatchObserved);
    window.removeEventListener("hashchange", dispatchObserved);
    window.removeEventListener(locationChangeEvent, dispatchObserved);
  };
}

function runMediaQuerySubscription(
  subscription: VxSubscriptionEnvelope,
  context: VxRuntimeExecutionContext,
): VxSubscriptionDisposer | void {
  const query = readRequiredStringField(subscription, "query", "media_query subscription");
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    throw new Error("vx-dom: media_query subscription requires window.matchMedia");
  }
  const media = window.matchMedia(query);
  const dispatch = () => {
    if (context.signal.aborted) return;
    settleAsyncDispatch(context.dispatch(subscriptionMessage(subscription, {
      kind: "media_query",
      query,
      matches: media.matches,
    })));
  };
  dispatch();
  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", dispatch);
    return () => media.removeEventListener("change", dispatch);
  }
  media.addListener(dispatch);
  return () => media.removeListener(dispatch);
}

function runOnlineStatusSubscription(
  subscription: VxSubscriptionEnvelope,
  context: VxRuntimeExecutionContext,
): VxSubscriptionDisposer | void {
  if (typeof window === "undefined") return;
  const dispatch = () => {
    if (context.signal.aborted) return;
    const online = typeof navigator === "undefined" ? true : navigator.onLine;
    settleAsyncDispatch(context.dispatch(subscriptionMessage(subscription, online)));
  };
  window.addEventListener("online", dispatch);
  window.addEventListener("offline", dispatch);
  dispatch();
  return () => {
    window.removeEventListener("online", dispatch);
    window.removeEventListener("offline", dispatch);
  };
}

function runStorageSubscription(
  subscription: VxSubscriptionEnvelope,
  context: VxRuntimeExecutionContext,
): VxSubscriptionDisposer | void {
  if (typeof window === "undefined") return;
  const listener = (event: StorageEvent) => {
    if (context.signal.aborted) return;
    settleAsyncDispatch(context.dispatch(subscriptionMessage(subscription, storagePayload(event))));
  };
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}

function runVisibilityChangeSubscription(
  subscription: VxSubscriptionEnvelope,
  context: VxRuntimeExecutionContext,
): VxSubscriptionDisposer | void {
  if (typeof document === "undefined") return;
  const dispatch = () => {
    if (context.signal.aborted) return;
    settleAsyncDispatch(context.dispatch(subscriptionMessage(subscription, {
      kind: "visibility",
      state: document.visibilityState,
      hidden: document.hidden,
    })));
  };
  document.addEventListener("visibilitychange", dispatch);
  dispatch();
  return () => document.removeEventListener("visibilitychange", dispatch);
}

function runWindowResizeSubscription(
  subscription: VxSubscriptionEnvelope,
  context: VxRuntimeExecutionContext,
): VxSubscriptionDisposer | void {
  if (typeof window === "undefined") return;
  const dispatch = () => {
    if (context.signal.aborted) return;
    settleAsyncDispatch(context.dispatch(subscriptionMessage(subscription, {
      kind: "window_size",
      width: window.innerWidth,
      height: window.innerHeight,
    })));
  };
  window.addEventListener("resize", dispatch);
  dispatch();
  return () => window.removeEventListener("resize", dispatch);
}

function runWindowEventSubscription(
  subscription: VxSubscriptionEnvelope,
  context: VxRuntimeExecutionContext,
): VxSubscriptionDisposer | void {
  if (typeof window === "undefined") return;
  const eventName = windowEventName(subscription);
  const listener = () => {
    if (context.signal.aborted) return;
    settleAsyncDispatch(context.dispatch(subscriptionMessage(subscription, {
      kind: "event",
      event: eventName,
    })));
  };
  window.addEventListener(eventName, listener);
  return () => window.removeEventListener(eventName, listener);
}

function windowEventName(subscription: VxSubscriptionEnvelope): string {
  if (typeof subscription.event === "string") return subscription.event;
  if (subscription.kind === "window_focus") return "focus";
  if (subscription.kind === "window_blur") return "blur";
  return subscription.kind;
}

async function syncRuntimeSubscriptions(
  input: unknown,
  active: Map<string, ActiveSubscription>,
  host: VxRuntimeHostOptions | undefined,
  context: VxRuntimeExecutionContext,
  releaser?: RetainedHandlerReleaser,
): Promise<void> {
  const next = flattenSubscriptions(input);
  const nextKeys = new Set(next.map(subscriptionIdentityKey));

  for (const [key, record] of active) {
    if (nextKeys.has(key)) continue;
    active.delete(key);
    await disposeActiveSubscription(record, releaser, active);
  }

  for (const subscription of next) {
    const key = subscriptionIdentityKey(subscription);
    const signature = subscriptionSignature(subscription);
    const mapHandlerIds = mappedHandlerIds(subscription);
    const ownedMapHandlerIds = mappedOwnedHandlerIds(subscription);
    const previous = active.get(key);
    if (previous?.signature === signature) {
      updateActiveSubscriptionMapHandlers(previous, mapHandlerIds, ownedMapHandlerIds, releaser, active);
      continue;
    }
    if (previous) {
      active.delete(key);
      await disposeActiveSubscription(previous, releaser, active);
    }
    const runner = host?.subscriptions?.[subscription.kind];
    if (!runner) throw new Error(`vx-dom: no runtime subscription handler registered for "${subscription.kind}"`);
    const mappedContext = mutableMappedSubscriptionContext(subscription, context);
    const dispose = await runner(subscription, mappedContext.context);
    active.set(key, {
      signature,
      dispose: dispose ?? (() => undefined),
      mapHandlerIds,
      ownedMapHandlerIds,
      setMapHandlerIds: mappedContext.setMapHandlerIds,
    });
  }
}

async function disposeSubscriptions(
  active: Map<string, ActiveSubscription>,
  releaser?: RetainedHandlerReleaser,
): Promise<void> {
  const records = Array.from(active.values());
  active.clear();
  for (const record of records) await disposeActiveSubscription(record, releaser, active);
}

async function disposeActiveSubscription(
  record: ActiveSubscription,
  releaser: RetainedHandlerReleaser | undefined,
  active: Map<string, ActiveSubscription>,
): Promise<void> {
  try {
    await record.dispose();
  } finally {
    releaseRetainedHandlers(record.ownedMapHandlerIds, releaser, active);
  }
}

function updateActiveSubscriptionMapHandlers(
  record: ActiveSubscription,
  nextIds: number[],
  nextOwnedIds: number[],
  releaser: RetainedHandlerReleaser | undefined,
  active: Map<string, ActiveSubscription>,
): void {
  const removed = record.ownedMapHandlerIds.filter((id) => !nextOwnedIds.includes(id));
  record.mapHandlerIds = nextIds;
  record.ownedMapHandlerIds = nextOwnedIds;
  record.setMapHandlerIds(nextIds);
  releaseRetainedHandlers(removed, releaser, active);
}

function releaseRetainedHandlers(
  ids: readonly number[],
  releaser: RetainedHandlerReleaser | undefined,
  active: Map<string, ActiveSubscription>,
): void {
  const inactiveIds = Array.from(new Set(ids))
    .filter((id) => !activeSubscriptionUsesHandler(active, id));
  if (inactiveIds.length === 0) return;
  if (releaser?.releaseMany) {
    releaser.releaseMany(inactiveIds);
    return;
  }
  inactiveIds.forEach((id) => releaser?.release?.(id));
}

function activeSubscriptionUsesHandler(
  active: Map<string, ActiveSubscription>,
  id: number,
): boolean {
  return Array.from(active.values()).some((record) => record.ownedMapHandlerIds.includes(id));
}

function flattenSubscriptions(
  input: unknown,
  mapHandlerIds: number[] = [],
  mapHandlerKeys: string[] = [],
  ownedMapHandlerIds: number[] = [],
): VxSubscriptionEnvelope[] {
  if (input === undefined || input === null) return [];
  if (Array.isArray(input)) {
    return input.flatMap((child) =>
      flattenSubscriptions(child, mapHandlerIds, mapHandlerKeys, ownedMapHandlerIds)
    );
  }
  const envelope = readRuntimeEnvelope(input, "sub", "subscriptions");
  if (envelope.kind === "none") return [];
  if (envelope.kind === "batch") {
    if (!Object.hasOwn(envelope, "children")) {
      throw new Error("vx-dom: subscription batch missing required children");
    }
    return flattenSubscriptions(envelope.children, mapHandlerIds, mapHandlerKeys, ownedMapHandlerIds);
  }
  if (envelope.kind === "map") {
    const handlerId = readHandlerId(envelope);
    if (handlerId === undefined) throw new Error("vx-dom: subscription map missing numeric handlerId");
    const handlerKey = readHandlerKey(envelope);
    const ownedHandlerIds = mappedOwnedHandlerIds(envelope);
    return flattenSubscriptions(
      readRequiredMappedChild(envelope, "subscription map"),
      [...mapHandlerIds, handlerId],
      [...mapHandlerKeys, handlerKey ?? `id:${handlerId}`],
      [...ownedMapHandlerIds, ...ownedHandlerIds],
    );
  }
  if (!optionalSubscriptionKey(envelope)) {
    throw new Error(`vx-dom: subscription "${envelope.kind}" requires a stable key`);
  }
  if (mapHandlerIds.length === 0) return [envelope];
  return [{
    ...envelope,
    [mapHandlerIdsProperty]: mapHandlerIds,
    [mapHandlerKeysProperty]: mapHandlerKeys,
    ...(ownedMapHandlerIds.length > 0
      ? { [ownedMapHandlerIdsProperty]: ownedMapHandlerIds }
      : {}),
  }];
}

function subscriptionIdentityKey(subscription: VxSubscriptionEnvelope): string {
  const mapPrefix = mappedHandlerIdentityParts(subscription)
    .join("/");
  const explicitKey = subscription.key ?? subscription.id;
  const base = `${subscriptionIdentityKind(subscription)}:${String(explicitKey)}`;
  return mapPrefix ? `${mapPrefix}|${base}` : base;
}

function subscriptionIdentityKind(subscription: VxSubscriptionEnvelope): string {
  if (subscription.kind === "keyboard" && typeof subscription.event === "string") {
    return `${subscription.kind}:${subscription.event}`;
  }
  return subscription.kind;
}

function subscriptionSignature(subscription: VxSubscriptionEnvelope): string {
  const normalized = { ...subscription };
  delete normalized[mapHandlerIdsProperty];
  delete normalized[mapHandlerKeysProperty];
  delete normalized[ownedMapHandlerIdsProperty];
  const mappedIdentity = mappedHandlerIdentityParts(subscription);
  if (mappedIdentity.length > 0) normalized[mapHandlerIdentityProperty] = mappedIdentity;
  return stableStringify(normalized);
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

function readRequiredStringValue(
  input: Record<string, unknown>,
  commandKind: string,
): string {
  if (typeof input.value !== "string") {
    throw new Error(`vx-dom: ${commandKind} command missing string value`);
  }
  return input.value;
}

function readBrowserStorage(commandKind: string, storageKind: "local" | "session"): Storage {
  const storage = storageKind === "local"
    ? typeof localStorage === "undefined" ? undefined : localStorage
    : typeof sessionStorage === "undefined" ? undefined : sessionStorage;
  if (!storage) throw new Error(`vx-dom: ${commandKind} command requires ${storageKind}Storage`);
  return storage;
}

function readOpenUrlTarget(command: VxCommandEnvelope): { url: string; target?: string } {
  if (typeof command.value === "string") return { url: command.value, target: "_blank" };
  if (!isRecord(command.value) || typeof command.value.url !== "string") {
    throw new Error("vx-dom: open_url command missing string url");
  }
  return {
    url: command.value.url,
    target: typeof command.value.target === "string" ? command.value.target : "_blank",
  };
}

function readPointValue(
  command: VxCommandEnvelope,
  commandKind: string,
): { x: number; y: number } {
  if (
    !isRecord(command.value) ||
    typeof command.value.x !== "number" ||
    typeof command.value.y !== "number" ||
    !Number.isFinite(command.value.x) ||
    !Number.isFinite(command.value.y)
  ) {
    throw new Error(`vx-dom: ${commandKind} command missing numeric x/y value`);
  }
  return { x: command.value.x, y: command.value.y };
}

function readRequiredStringField(
  input: Record<string, unknown>,
  field: string,
  label: string,
): string {
  const value = input[field];
  if (typeof value !== "string") {
    throw new Error(`vx-dom: ${label} missing string ${field}`);
  }
  return value;
}

function readStorageEntry(
  command: VxCommandEnvelope,
  commandKind: string,
): { key: string; value: string } {
  if (
    !isRecord(command.value) ||
    typeof command.value.key !== "string" ||
    typeof command.value.value !== "string"
  ) {
    throw new Error(`vx-dom: ${commandKind} command missing string key/value`);
  }
  return { key: command.value.key, value: command.value.value };
}

function subscriptionMessage(
  subscription: VxSubscriptionEnvelope,
  payload: unknown,
): VxRuntimeSubscriptionMessage {
  return {
    kind: "subscription",
    subscriptionKind: subscription.kind,
    key: optionalSubscriptionKey(subscription),
    ...(shouldDispatchSubscriptionValue(subscription) ? { value: subscription.value } : {}),
    payload,
  };
}

function shouldDispatchSubscriptionValue(subscription: VxSubscriptionEnvelope): boolean {
  return Object.hasOwn(subscription, "value") && subscription.valueRole !== "config";
}

function dispatchLocationChange(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(locationChangeEvent));
}

function locationPayload(): Record<string, string> {
  if (typeof location === "undefined") {
    return {
      kind: "location",
      href: "",
      pathname: "",
      search: "",
      hash: "",
    };
  }
  return {
    kind: "location",
    href: location.href,
    pathname: location.pathname,
    search: location.search,
    hash: location.hash,
  };
}

function storagePayload(event: StorageEvent): Record<string, unknown> {
  return {
    kind: "storage",
    storage: storageKind(event.storageArea),
    ...(event.key !== null ? { key: event.key } : {}),
    ...(event.oldValue !== null ? { old_value: event.oldValue } : {}),
    ...(event.newValue !== null ? { new_value: event.newValue } : {}),
    url: event.url ?? "",
  };
}

function storageKind(storageArea: Storage | null): string {
  if (typeof sessionStorage !== "undefined" && storageArea === sessionStorage) return "session";
  if (typeof localStorage !== "undefined" && storageArea === localStorage) return "local";
  return "unknown";
}

function mapExecutionContext(
  context: VxRuntimeExecutionContext,
  handlerId: number,
): VxRuntimeExecutionContext {
  return {
    signal: context.signal,
    deferAfterCommands: context.deferAfterCommands,
    releaseRetainedHandler: context.releaseRetainedHandler,
    trackRetainedHandlerUse: context.trackRetainedHandlerUse,
    reportError: context.reportError,
    dispatch: (message) => context.dispatch({ kind: "map", handlerId, message }),
  };
}

function ownedCommandMapExecutionContext(
  context: VxRuntimeExecutionContext,
  handlerId: number,
  ownedHandlerIds: readonly number[],
): {
  context: VxRuntimeExecutionContext;
  finish: () => void;
} {
  if (ownedHandlerIds.length === 0) {
    return {
      context: mapExecutionContext(context, handlerId),
      finish: () => undefined,
    };
  }

  let commandReturned = false;
  let pendingUses = 0;
  let released = false;
  const releaseIfDone = () => {
    if (!commandReturned || pendingUses > 0 || released) return;
    released = true;
    ownedHandlerIds.forEach((id) => context.releaseRetainedHandler?.(id));
  };
  const trackUse = (result: Promise<unknown> | unknown) => {
    pendingUses += 1;
    context.trackRetainedHandlerUse?.(result);
    void Promise.resolve(result).catch(() => undefined).then(() => {
      pendingUses -= 1;
      releaseIfDone();
    });
  };

  return {
    context: {
      signal: context.signal,
      deferAfterCommands: context.deferAfterCommands,
      releaseRetainedHandler: context.releaseRetainedHandler,
      trackRetainedHandlerUse: trackUse,
      reportError: context.reportError,
      dispatch: (message) => {
        const result = context.dispatch({ kind: "map", handlerId, message });
        trackUse(result);
        return result;
      },
    },
    finish: () => {
      commandReturned = true;
      releaseIfDone();
    },
  };
}

function mutableMappedSubscriptionContext(
  subscription: VxSubscriptionEnvelope,
  context: VxRuntimeExecutionContext,
): {
  context: VxRuntimeExecutionContext;
  setMapHandlerIds: (ids: number[]) => void;
} {
  let mapHandlerIds = mappedHandlerIds(subscription);
  return {
    context: {
      signal: context.signal,
      deferAfterCommands: context.deferAfterCommands,
      releaseRetainedHandler: context.releaseRetainedHandler,
      trackRetainedHandlerUse: context.trackRetainedHandlerUse,
      reportError: context.reportError,
      dispatch: (message) => context.dispatch(mapRuntimeMessage(message, mapHandlerIds)),
    },
    setMapHandlerIds: (ids) => {
      mapHandlerIds = ids;
    },
  };
}

function mappedHandlerIds(subscription: VxSubscriptionEnvelope): number[] {
  const raw = subscription[mapHandlerIdsProperty];
  return Array.isArray(raw) ? raw.filter((id): id is number => typeof id === "number") : [];
}

function mappedOwnedHandlerIds(input: Record<string, unknown>): number[] {
  const raw = input[ownedMapHandlerIdsProperty];
  return Array.isArray(raw) ? raw.filter((id): id is number => typeof id === "number") : [];
}

function mappedHandlerKeys(subscription: VxSubscriptionEnvelope): string[] {
  const raw = subscription[mapHandlerKeysProperty];
  return Array.isArray(raw)
    ? raw
        .filter((key): key is string | number => typeof key === "string" || typeof key === "number")
        .map((key) => String(key))
    : [];
}

function mappedHandlerIdentityParts(subscription: VxSubscriptionEnvelope): string[] {
  const keys = mappedHandlerKeys(subscription);
  if (keys.length > 0) return keys.map((key) => `key:${key}`);
  return mappedHandlerIds(subscription).map((id) => `id:${id}`);
}

function readHandlerId(input: Record<string, unknown>): number | undefined {
  return typeof input.handlerId === "number"
    ? input.handlerId
    : typeof input.handler_id === "number"
      ? input.handler_id
      : undefined;
}

function readHandlerKey(input: Record<string, unknown>): string | undefined {
  const raw = input.handlerKey ?? input.handler_key;
  return typeof raw === "string" || typeof raw === "number" ? String(raw) : undefined;
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
  return handlerIds.reduceRight<VxRuntimeMessage>(
    (child, handlerId) => ({ kind: "map", handlerId, message: child }),
    message,
  );
}

function mapDomEventMessage(message: VxRuntimeMessage, handlerIds: readonly number[]): VxRuntimeMessage {
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
