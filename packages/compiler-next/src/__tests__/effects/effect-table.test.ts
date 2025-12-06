import { describe, expect, it } from "vitest";
import { createEffectTable } from "../../semantics/effects/effect-table.js";
import type { NodeId, TypeSchemeId } from "../../semantics/ids.js";

describe("EffectTable", () => {
  it("interns rows canonically and caches duplicates", () => {
    const effects = createEffectTable();
    const rowA = effects.internRow({
      operations: [
        { name: "Log.write" },
        { name: "Async.await" },
        { name: "Async.await" },
      ],
    });
    const rowB = effects.internRow({
      operations: [{ name: "Async.await" }, { name: "Log.write" }],
    });
    expect(rowA).toBe(rowB);
    const desc = effects.getRow(rowA);
    expect(desc.operations).toEqual([
      { name: "Async.await" },
      { name: "Log.write" },
    ]);
  });

  it("composes rows and preserves tail variables", () => {
    const effects = createEffectTable();
    const tail = effects.freshTailVar();
    const left = effects.internRow({
      operations: [{ name: "Async.await" }],
      tailVar: tail,
    });
    const right = effects.internRow({
      operations: [{ name: "Log.write" }],
    });

    const composed = effects.compose(left, right);
    const desc = effects.getRow(composed);
    expect(desc.operations).toEqual([
      { name: "Async.await" },
      { name: "Log.write" },
    ]);
    expect(desc.tailVar?.id).toBe(tail.id);
  });

  it("constrains sub-rows into super-rows with substitutions", () => {
    const effects = createEffectTable();
    const supTail = effects.freshTailVar();
    const sup = effects.internRow({
      operations: [{ name: "Async.await" }],
      tailVar: supTail,
    });
    const sub = effects.internRow({
      operations: [{ name: "Async.await" }, { name: "Log.write" }],
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
    expect(tailRow.operations).toEqual([{ name: "Log.write" }]);
  });

  it("flags conflicts when constraining closed rows", () => {
    const effects = createEffectTable();
    const sup = effects.internRow({ operations: [{ name: "Async.await" }] });
    const sub = effects.internRow({
      operations: [{ name: "Async.await" }, { name: "Log.write" }],
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
    const row = effects.internRow({ operations: [{ name: "Async.await" }] });
    effects.setExprEffect(1, row);
    effects.setExprEffect(1, row);
    expect(effects.getExprEffect(1)).toBe(row);
    expect(() => effects.setExprEffect(1, effects.emptyRow)).toThrow();

    const scheme: TypeSchemeId = 7;
    effects.setFunctionEffect(2, scheme, row);
    effects.setFunctionEffect(2, scheme, row);
    expect(effects.getFunctionEffect(2)).toBe(row);
    expect(() => effects.setFunctionEffect(2, scheme, effects.emptyRow)).toThrow();
  });

  it("exposes empty vs open rows", () => {
    const effects = createEffectTable();
    expect(effects.isEmpty(effects.emptyRow)).toBe(true);
    expect(effects.isOpen(effects.emptyRow)).toBe(false);
    expect(effects.isOpen(effects.unknownRow)).toBe(true);
  });
});
