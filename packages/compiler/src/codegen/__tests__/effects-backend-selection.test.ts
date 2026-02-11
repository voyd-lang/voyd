import { describe, expect, it } from "vitest";
import { selectEffectsBackend } from "../effects/codegen-backend.js";
import type { CodegenContext } from "../context.js";
import { parse } from "../../parser/parser.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { buildProgramCodegenView } from "../../semantics/codegen-view/index.js";
import { codegenProgramWithContinuationFallback } from "../codegen.js";

const makeCtx = (stackSwitching: boolean): CodegenContext =>
  ({ options: { continuationBackend: { stackSwitching } } } as any);

describe("effects backend selection", () => {
  it("defaults to gc-trampoline when stack switching disabled", () => {
    const backend = selectEffectsBackend(makeCtx(false));
    expect(backend.kind).toBe("gc-trampoline");
    expect(backend.requestedKind).toBe("gc-trampoline");
  });

  it("fails closed to gc-trampoline when stack switching is requested", () => {
    const backend = selectEffectsBackend(makeCtx(true));
    expect(backend.kind).toBe("gc-trampoline");
    expect(backend.requestedKind).toBe("stack-switch");
    expect(backend.stackSwitchUnavailableReason).toMatch(/not implemented/i);
  });

  it("does not synthesize a fake stack-switch preferred artifact", () => {
    const source = `eff Async
  await(tail) -> i32

pub fn main(): () -> i32
  try
    Async::await()
  Async::await(tail):
    tail(10)
`;
    const semantics = semanticsPipeline(parse(source, "/proj/src/effects-backend-selection.voyd"));
    const program = buildProgramCodegenView([semantics]);
    const result = codegenProgramWithContinuationFallback({
      program,
      entryModuleId: semantics.moduleId,
      options: {
        continuationBackend: {
          stackSwitching: true,
        },
      },
    });

    expect(result.preferredKind).toBe("gc-trampoline");
    expect(result.preferred.continuationBackendKind).toBe("gc-trampoline");
    expect(result.fallback).toBeUndefined();
    expect(result.preferred.module.emitText()).toContain("voydContinuation");
  });
});
