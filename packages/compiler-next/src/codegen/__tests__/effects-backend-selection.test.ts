import { describe, expect, it } from "vitest";
import { selectEffectsBackend } from "../effects/codegen-backend.js";
import type { CodegenContext } from "../context.js";

const makeCtx = (stackSwitching: boolean): CodegenContext =>
  ({ effectMir: { stackSwitching } } as any);

describe("effects backend selection", () => {
  it("defaults to gc-trampoline when stack switching disabled", () => {
    const backend = selectEffectsBackend(makeCtx(false));
    expect(backend.kind).toBe("gc-trampoline");
  });

  it("marks stack-switch when stack switching enabled", () => {
    const backend = selectEffectsBackend(makeCtx(true));
    expect(backend.kind).toBe("stack-switch");
  });
});

