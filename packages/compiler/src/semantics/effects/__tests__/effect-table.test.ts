import { describe, expect, it } from "vitest";
import { createEffectTable } from "../effect-table.js";
import type { NodeId, TypeSchemeId } from "../../ids.js";

const effectOp = (name: string) => {
  const effectName = name.split(".")[0]!;
  const effect = { Async: 1, Log: 2, State: 3 }[effectName] ?? 0;
  return {
    identity: { moduleId: "test", effect, operation: 0 },
    name,
  };
};

describe("EffectTable", () => {
  it("interns rows canonically and caches duplicates", () => {
    const effects = createEffectTable();
    const rowA = effects.internRow({
      operations: [
        effectOp("Log.write"),
        effectOp("Async.await"),
        effectOp("Async.await"),
      ],
    });
    const rowB = effects.internRow({
      operations: [effectOp("Async.await"), effectOp("Log.write")],
    });
    expect(rowA).toBe(rowB);
    const desc = effects.getRow(rowA);
    expect(desc.operations.map((op) => op.name)).toEqual([
      "Async.await",
      "Log.write",
    ]);
  });

  it("keys operations by semantic identity instead of display name", () => {
    const effects = createEffectTable();
    const left = {
      identity: { moduleId: "src::left", effect: 1, operation: 2 },
      name: "Store.save(i32)",
    };
    const right = {
      identity: { moduleId: "src::right", effect: 1, operation: 2 },
      name: "Store.save(i32)",
    };
    const combined = effects.internRow({ operations: [left, right] });
    expect(effects.getRow(combined).operations).toHaveLength(2);

    const renamed = effects.internRow({
      operations: [{ ...left, name: "Alias.persist(i32)" }],
    });
    const original = effects.internRow({ operations: [left] });
    expect(renamed).toBe(original);
  });

  it("composes rows and preserves tail variables", () => {
    const effects = createEffectTable();
    const tail = effects.freshTailVar();
    const left = effects.internRow({
      operations: [effectOp("Async.await")],
      tailVar: tail,
    });
    const right = effects.internRow({
      operations: [effectOp("Log.write")],
    });

    const composed = effects.compose(left, right);
    const desc = effects.getRow(composed);
    expect(desc.operations.map((op) => op.name)).toEqual([
      "Async.await",
      "Log.write",
    ]);
    expect(desc.tailVar?.id).toBe(tail.id);
  });

  it("constrains sub-rows into super-rows with substitutions", () => {
    const effects = createEffectTable();
    const supTail = effects.freshTailVar();
    const sup = effects.internRow({
      operations: [effectOp("Async.await")],
      tailVar: supTail,
    });
    const sub = effects.internRow({
      operations: [effectOp("Async.await"), effectOp("Log.write")],
    });

    const result = effects.constrain(sub, sup, {
      location: 0 as NodeId,
      reason: "annotation",
    });
    expect(result.ok).toBe(true);
    const substitution = result.ok ? result.substitution.rows : undefined;
    const tailRowId = substitution?.get(supTail.id);
    expect(typeof tailRowId).toBe("number");
    const tailRow = effects.getRow(tailRowId!);
    expect(tailRow.operations.map((op) => op.name)).toEqual(["Log.write"]);
  });

  it("binds open super-row tails to empty rows for closed sub-rows", () => {
    const effects = createEffectTable();
    const supTail = effects.freshTailVar();
    const sup = effects.internRow({
      operations: [],
      tailVar: supTail,
    });
    const sub = effects.internRow({
      operations: [],
    });

    const result = effects.constrain(sub, sup, {
      location: 0 as NodeId,
      reason: "closed specialization",
    });
    expect(result.ok).toBe(true);
    const substitution = result.ok ? result.substitution.rows : undefined;
    const tailRowId = substitution?.get(supTail.id);
    expect(typeof tailRowId).toBe("number");
    expect(tailRowId).toBe(effects.emptyRow);
  });

  it("flags conflicts when constraining closed rows", () => {
    const effects = createEffectTable();
    const sup = effects.internRow({ operations: [effectOp("Async.await")] });
    const sub = effects.internRow({
      operations: [effectOp("Async.await"), effectOp("Log.write")],
    });

    const result = effects.constrain(sub, sup, {
      location: 0 as NodeId,
      reason: "closed row",
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.conflict.message).toContain("Log.write");
  });

  it("records expr and function effects idempotently", () => {
    const effects = createEffectTable();
    const row = effects.internRow({ operations: [effectOp("Async.await")] });
    effects.setExprEffect(1, row);
    effects.setExprEffect(1, row);
    const added = effects.internRow({ operations: [effectOp("Log.write")] });
    effects.setExprEffect(1, effects.emptyRow);
    effects.setExprEffect(1, added);
    const combined = effects.getExprEffect(1);
    expect(combined).toBeTypeOf("number");
    const desc = effects.getRow(combined!);
    expect(desc.operations.map((op) => op.name)).toEqual([
      "Async.await",
      "Log.write",
    ]);

    const scheme: TypeSchemeId = 7;
    effects.setFunctionEffect(2, scheme, row);
    effects.setFunctionEffect(2, scheme, row);
    expect(effects.getFunctionEffect(2)).toBe(row);
    expect(() =>
      effects.setFunctionEffect(2, scheme, effects.emptyRow),
    ).toThrow();
  });

  it("rolls back nested expression effect scopes", () => {
    const effects = createEffectTable();
    const initial = effects.internRow({
      operations: [effectOp("Async.await")],
    });
    const outer = effects.internRow({ operations: [effectOp("Log.write")] });
    const inner = effects.internRow({ operations: [effectOp("State.get")] });
    effects.setExprEffect(1, initial);

    effects.pushExprEffectScope();
    effects.setExprEffect(1, outer);
    effects.setExprEffect(2, outer);
    const outerComposed = effects.getExprEffect(1);

    effects.pushExprEffectScope();
    effects.setExprEffect(1, inner);
    effects.setExprEffect(3, inner);
    effects.popExprEffectScope();

    expect(effects.getExprEffect(1)).toBe(outerComposed);
    expect(effects.getExprEffect(2)).toBe(outer);
    expect(effects.getExprEffect(3)).toBeUndefined();

    effects.popExprEffectScope();
    expect(effects.getExprEffect(1)).toBe(initial);
    expect(effects.getExprEffect(2)).toBeUndefined();
  });

  it("exposes empty vs open rows", () => {
    const effects = createEffectTable();
    expect(effects.isEmpty(effects.emptyRow)).toBe(true);
    expect(effects.isOpen(effects.emptyRow)).toBe(false);
    expect(effects.isOpen(effects.unknownRow)).toBe(true);
  });
});
