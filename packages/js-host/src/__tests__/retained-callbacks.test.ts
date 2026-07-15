import { describe, expect, it, vi } from "vitest";
import {
  createRetainedCallbackScopeManager,
  createRetainedEventHandlerRegistry,
  type RetainedEventHandlerRegistry,
} from "../retained-callbacks.js";

describe("retained event handler registry", () => {
  it("dispatches retained handlers and returns user messages", async () => {
    const registry = createRetainedEventHandlerRegistry<{ value: string }>();
    const handler = vi.fn(() => ({ user: "msg" }));
    const id = registry.retain(handler);

    await expect(registry.dispatch(id, { value: "clicked" })).resolves.toEqual({
      user: "msg",
    });
    expect(handler).toHaveBeenCalledWith({ value: "clicked" });
  });

  it("releases handlers individually and in batches", async () => {
    const registry = createRetainedEventHandlerRegistry<string>();
    const first = vi.fn();
    const second = vi.fn();
    const firstId = registry.retain(first);
    const secondId = registry.retain(second);

    registry.release(firstId);
    await registry.dispatch(firstId, "one");
    await registry.dispatch(secondId, "two");

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("two");

    registry.releaseMany([secondId]);
    await registry.dispatch(secondId, "again");
    expect(second).toHaveBeenCalledTimes(1);
    expect(registry.size()).toBe(0);
  });

  it("releases only callbacks retained by the completed scope", async () => {
    const registry = createRetainedEventHandlerRegistry<string>();
    const scopes = createRetainedCallbackScopeManager(registry);
    const stableHandler = vi.fn();
    const outerHandler = vi.fn();
    const innerHandler = vi.fn();
    const stableId = registry.retain(stableHandler);
    const outerScope = scopes.beginScope(1);
    const outerId = scopes.retain(1, outerHandler);
    const innerScope = scopes.beginScope(1);
    const innerId = scopes.retain(1, innerHandler);

    scopes.endScope(1, innerScope);

    expect(registry.size()).toBe(2);
    await registry.dispatch(innerId, "inner");
    await registry.dispatch(outerId, "outer");
    expect(innerHandler).not.toHaveBeenCalled();
    expect(outerHandler).toHaveBeenCalledWith("outer");

    scopes.endScope(1, outerScope);

    expect(registry.size()).toBe(1);
    await registry.dispatch(stableId, "stable");
    expect(stableHandler).toHaveBeenCalledWith("stable");
    registry.release(stableId);
  });

  it("isolates interleaved owners and releases failed-owner scopes", () => {
    const registry = createRetainedEventHandlerRegistry();
    const scopes = createRetainedCallbackScopeManager(registry);
    const firstScope = scopes.beginScope(10);
    scopes.retain(10, vi.fn());
    const secondScope = scopes.beginScope(20);
    scopes.retain(20, vi.fn());

    scopes.endScope(20, secondScope);
    expect(registry.size()).toBe(1);

    scopes.finishOwner(10);
    expect(registry.size()).toBe(0);
    expect(() => scopes.endScope(10, firstScope)).toThrow(
      "is not active for owner 10",
    );
  });

  it("releases callbacks retained while a render scope is active", () => {
    const registry = createRetainedEventHandlerRegistry();
    const scopes = createRetainedCallbackScopeManager(registry);
    const scope = scopes.beginScope("render");
    const retainedId = scopes.retain("render", vi.fn());

    expect(registry.size()).toBe(1);
    scopes.endScope("render", scope);

    expect(registry.size()).toBe(0);
    expect(() => registry.dispatch(retainedId, undefined)).not.toThrow();
  });

  it("claims prebuilt render callbacks into the active scope", () => {
    const registry = createRetainedEventHandlerRegistry();
    const scopes = createRetainedCallbackScopeManager(registry);
    const pendingId = scopes.retain("render", vi.fn());

    const scope = scopes.beginScope("render");
    scopes.claim("render", pendingId);
    scopes.endScope("render", scope);
    scopes.finishOwner("render");

    expect(registry.size()).toBe(0);
  });

  it("does not claim explicit caller-owned callbacks", () => {
    const registry = createRetainedEventHandlerRegistry();
    const scopes = createRetainedCallbackScopeManager(registry);
    const explicitId = registry.retain(vi.fn());

    const scope = scopes.beginScope("render");
    scopes.claim("render", explicitId);
    scopes.endScope("render", scope);

    expect(registry.size()).toBe(1);
    registry.release(explicitId);
  });

  it("does not track browser callbacks retained outside a scope", () => {
    const registry = createRetainedEventHandlerRegistry();
    const scopes = createRetainedCallbackScopeManager(registry);
    const id = scopes.retain("browser", vi.fn());

    scopes.finishOwner("browser");

    expect(registry.size()).toBe(1);
    registry.release(id);
  });

  it("forgets a scope even when registry cleanup fails", () => {
    const base = createRetainedEventHandlerRegistry();
    const registry: RetainedEventHandlerRegistry = {
      ...base,
      releaseMany: () => {
        throw new Error("cleanup failed");
      },
    };
    const scopes = createRetainedCallbackScopeManager(registry);
    const scope = scopes.beginScope(1);
    scopes.retain(1, vi.fn());

    expect(() => scopes.endScope(1, scope)).toThrow("cleanup failed");
    expect(() => scopes.endScope(1, scope)).toThrow(
      "is not active for owner 1",
    );
  });
});
