import { describe, expect, it, vi } from "vitest";
import { createRetainedEventHandlerRegistry } from "../retained-callbacks.js";

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
});
