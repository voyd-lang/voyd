import binaryen from "binaryen";
import { describe, expect, it } from "vitest";
import {
  createEffectRuntime,
  OUTCOME_TAGS,
  RESUME_KIND,
} from "../effects/runtime-abi.js";

const makeModule = () => {
  const mod = new binaryen.Module();
  mod.setFeatures(binaryen.Features.All);
  return mod;
};

describe("effect runtime ABI helpers", () => {
  it("defines the expected struct types", () => {
    const mod = makeModule();
    const runtime = createEffectRuntime(mod);
    const guard = runtime.makeTailGuard();
    const continuation = runtime.makeContinuation({
      fnRef: mod.ref.null(binaryen.funcref),
    });
    const request = runtime.makeEffectRequest({
      effectId: mod.i64.const(1, 0),
      opId: mod.i32.const(2),
      opIndex: mod.i32.const(0),
      resumeKind: mod.i32.const(RESUME_KIND.resume),
      handle: mod.i32.const(0),
      args: mod.ref.null(binaryen.eqref),
      continuation,
      tailGuard: guard,
    });
    const outcome = runtime.makeOutcomeEffect(request);
    const effectResult = runtime.makeEffectResult({
      status: mod.i32.const(0),
      cont: mod.ref.null(binaryen.anyref),
    });
    mod.addFunction(
      "touchTypes",
      binaryen.none,
      binaryen.none,
      [],
      mod.block(null, [mod.drop(outcome), mod.drop(effectResult)], binaryen.none)
    );
    const text = mod.emitText();
    expect(text).toContain("type $voydOutcome");
    expect(text).toContain("type $voydEffectRequest");
    expect(text).toContain("type $voydContinuation");
    expect(text).toContain("type $voydTailGuard");
    expect(text).toContain("type $voydEffectResult");
    expect(text).toContain("(field $site i32)");
  });

  it("builds well-typed outcomes and effect requests", () => {
    const mod = makeModule();
    const runtime = createEffectRuntime(mod);

    const continuation = runtime.makeContinuation({
      fnRef: mod.ref.null(binaryen.funcref),
      env: mod.ref.null(binaryen.anyref),
    });
    const guard = runtime.makeTailGuard();
    const request = runtime.makeEffectRequest({
      effectId: mod.i64.const(7, 0),
      opId: mod.i32.const(3),
      opIndex: mod.i32.const(1),
      resumeKind: mod.i32.const(RESUME_KIND.tail),
      handle: mod.i32.const(2),
      args: mod.ref.null(binaryen.eqref),
      continuation,
      tailGuard: guard,
    });
    const outcome = runtime.makeOutcomeEffect(request);
    const effectResult = runtime.makeEffectResult({
      status: mod.i32.const(1),
      cont: mod.ref.null(binaryen.anyref),
    });

    mod.addFunction(
      "buildOutcome",
      binaryen.none,
      runtime.outcomeType,
      [],
      outcome
    );

    mod.addFunction(
      "readTag",
      binaryen.createType([runtime.outcomeType]),
      binaryen.i32,
      [],
      runtime.outcomeTag(mod.local.get(0, runtime.outcomeType))
    );
    mod.addFunction(
      "touchEffectResult",
      binaryen.none,
      binaryen.none,
      [],
      mod.drop(effectResult)
    );

    expect(mod.validate()).toBeTruthy();

    const text = mod.emitText();
    expect(text).toContain("(struct (field $tag i32)");
    expect(text).toContain("(field $opIndex i32)");
    expect(text).toContain("(field $handle i32)");
    expect(text).toContain("(field $resumeKind i32)");
    expect(text).toContain("(field $cont (ref null $voydContinuation))");
    expect(text).toContain("(field $tailGuard (ref null $voydTailGuard))");
    expect(text).toContain("(field $status i32)");
  });

  it("exposes tag values for value vs effect outcomes", () => {
    expect(OUTCOME_TAGS.value).toBe(0);
    expect(OUTCOME_TAGS.effect).toBe(1);
    expect(RESUME_KIND.resume).toBe(0);
    expect(RESUME_KIND.tail).toBe(1);
  });
});
