import { describe, expect, it } from "vitest";
import { createEffectTable } from "../../effects/effect-table.js";
import { createTypeArena } from "../type-arena.js";
import { FunctionStore, type FunctionSignature } from "../types.js";

describe("function types carry effect rows", () => {
  it("records annotated effect rows on function signatures", () => {
    const effects = createEffectTable();
    const arena = createTypeArena();
    const i32 = arena.internPrimitive("i32");
    const effectRow = effects.internRow({ operations: [{ name: "Async.await" }] });

    const typeId = arena.internFunction({
      parameters: [{ type: i32, optional: false }],
      returnType: i32,
      effectRow,
    });
    const scheme = arena.newScheme([], typeId);
    const signature: FunctionSignature = {
      typeId,
      parameters: [{ type: i32, optional: false }],
      returnType: i32,
      hasExplicitReturn: false,
      annotatedReturn: false,
      effectRow,
      annotatedEffects: true,
      scheme,
    };

    const store = new FunctionStore();
    store.setSignature(1, signature);
    const stored = store.getSignature(1);
    expect(stored?.effectRow).toBe(effectRow);
    expect(stored?.annotatedEffects).toBe(true);
  });

  it("keeps effect rows on function descriptors and schemes", () => {
    const effects = createEffectTable();
    const arena = createTypeArena();
    const emptyRow = effects.emptyRow;
    const opRow = effects.internRow({ operations: [{ name: "Log.write" }] });
    const voidType = arena.internPrimitive("void");

    const pureFn = arena.internFunction({
      parameters: [],
      returnType: voidType,
      effectRow: emptyRow,
    });
    const effectfulFn = arena.internFunction({
      parameters: [],
      returnType: voidType,
      effectRow: opRow,
    });

    const pureDesc = arena.get(pureFn);
    const effectDesc = arena.get(effectfulFn);
    expect(pureDesc.kind).toBe("function");
    expect(effectDesc.kind).toBe("function");
    expect(pureDesc.kind === "function" ? pureDesc.effectRow : -1).toBe(emptyRow);
    expect(effectDesc.kind === "function" ? effectDesc.effectRow : -1).toBe(opRow);

    const scheme = arena.newScheme([], effectfulFn);
    const instantiated = arena.instantiate(scheme, []);
    const instantiatedDesc = arena.get(instantiated);
    expect(instantiatedDesc.kind).toBe("function");
    expect(
      instantiatedDesc.kind === "function" ? instantiatedDesc.effectRow : -1
    ).toBe(opRow);
  });

  it("preserves effect rows when instantiating polymorphic functions", () => {
    const effects = createEffectTable();
    const arena = createTypeArena();
    const tail = effects.freshTailVar();
    const tailRow = effects.internRow({
      operations: [{ name: "Async.await" }],
      tailVar: tail,
    });

    const typeParam = arena.freshTypeParam();
    const typeParamRef = arena.internTypeParamRef(typeParam);
    const fnType = arena.internFunction({
      parameters: [{ type: typeParamRef, optional: false }],
      returnType: typeParamRef,
      effectRow: tailRow,
    });
    const scheme = arena.newScheme([typeParam], fnType);
    const instantiated = arena.instantiate(scheme, [
      arena.internPrimitive("string"),
    ]);

    const instantiatedDesc = arena.get(instantiated);
    expect(instantiatedDesc.kind).toBe("function");
    expect(
      instantiatedDesc.kind === "function" ? instantiatedDesc.effectRow : -1
    ).toBe(tailRow);
  });
});
