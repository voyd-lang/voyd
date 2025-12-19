import { describe, expect, it } from "vitest";
import { semanticsPipeline } from "../../pipeline.js";
import { loadAst } from "../../__tests__/load-ast.js";

const getFirstCall = (hir: ReturnType<typeof semanticsPipeline>["hir"]) =>
  Array.from(hir.expressions.values()).find((expr) => expr.exprKind === "call");

describe("array literals", () => {
  it("infers a homogeneous primitive element type", () => {
    const { typing, hir } = semanticsPipeline(
      loadAst("array_literal_primitives.voyd")
    );
    const call = getFirstCall(hir);
    expect(call).toBeDefined();
    if (!call) return;
    const typeId = typing.table.getExprType(call.id);
    expect(typeId).toBeDefined();
    const desc = typing.arena.get(typeId!);
    expect(desc.kind).toBe("fixed-array");
    if (desc.kind === "fixed-array") {
      expect(typing.arena.get(desc.element)).toMatchObject({
        kind: "primitive",
        name: "i32",
      });
    }
  });

  it("unions nominal object elements", () => {
    const { typing, hir } = semanticsPipeline(
      loadAst("array_literal_nominal_union.voyd")
    );
    const call = getFirstCall(hir);
    expect(call).toBeDefined();
    if (!call) return;
    const typeId = typing.table.getExprType(call.id);
    const desc = typing.arena.get(typeId!);
    expect(desc.kind).toBe("fixed-array");
    if (desc.kind === "fixed-array") {
      const elementDesc = typing.arena.get(desc.element);
      expect(elementDesc.kind).toBe("union");
      if (elementDesc.kind === "union") {
        expect(elementDesc.members).toHaveLength(2);
      }
    }
  });

  it("collapses mixed structural objects to Object", () => {
    const { typing, hir } = semanticsPipeline(
      loadAst("array_literal_structural_mix.voyd")
    );
    const call = getFirstCall(hir);
    expect(call).toBeDefined();
    if (!call) return;
    const typeId = typing.table.getExprType(call.id);
    const desc = typing.arena.get(typeId!);
    expect(desc.kind).toBe("fixed-array");
    if (desc.kind === "fixed-array") {
      expect(desc.element).toBe(typing.objects.base.type);
    }
  });

  it("infers generic new_array type arguments from literal elements", () => {
    const { typing, hir, symbolTable } = semanticsPipeline(
      loadAst("array_literal_generic_new_array.voyd")
    );
    const callId = Array.from(typing.callTypeArguments.keys()).find((id) => {
      const expr = hir.expressions.get(id);
      if (!expr || expr.exprKind !== "call") return false;
      const callee = hir.expressions.get(expr.callee);
      if (!callee || callee.exprKind !== "identifier") return false;
      return symbolTable.getSymbol(callee.symbol).name === "new_array";
    });
    expect(callId).toBeDefined();
    if (!callId) return;
    const typeArgs = typing.callTypeArguments.get(callId);
    expect(typeArgs).toBeDefined();
    if (!typeArgs) return;
    expect(typeArgs).toHaveLength(1);
    const typeArgDesc = typing.arena.get(typeArgs[0]!);
    expect(typeArgDesc).toMatchObject({ kind: "primitive", name: "f64" });
    const callTypeId = typing.table.getExprType(callId);
    expect(callTypeId).toBeDefined();
    const callDesc = typing.arena.get(callTypeId!);
    const nominalTypeId =
      callDesc.kind === "nominal-object"
        ? callTypeId
        : callDesc.kind === "intersection"
        ? callDesc.nominal
        : undefined;
    expect(typeof nominalTypeId).toBe("number");
    if (typeof nominalTypeId !== "number") return;
    const nominalDesc = typing.arena.get(nominalTypeId);
    expect(nominalDesc.kind).toBe("nominal-object");
    if (nominalDesc.kind === "nominal-object") {
      expect(nominalDesc.typeArgs[0]).toBe(typeArgs[0]);
    }
  });

  it("errors on mixed primitive elements", () => {
    expect(() =>
      semanticsPipeline(loadAst("array_literal_mixed_primitives.voyd"))
    ).toThrow(/array literal elements must not mix primitive types/);
  });

  it("errors on empty array literals without a type hint", () => {
    expect(() =>
      semanticsPipeline(loadAst("array_literal_empty.voyd"))
    ).toThrow(
      /__array_new_fixed requires at least one element to infer the element type/
    );
  });

  it("honors explicit type arguments for empty literals", () => {
    const { typing, hir } = semanticsPipeline(
      loadAst("array_literal_empty_with_type_arg.voyd")
    );
    const call = getFirstCall(hir);
    expect(call).toBeDefined();
    if (!call) return;
    const typeId = typing.table.getExprType(call.id);
    const desc = typing.arena.get(typeId!);
    expect(desc.kind).toBe("fixed-array");
    if (desc.kind === "fixed-array") {
      expect(typing.arena.get(desc.element)).toMatchObject({
        kind: "primitive",
        name: "i32",
      });
    }
  });

  it("enforces explicit type arguments for provided elements", () => {
    expect(() =>
      semanticsPipeline(loadAst("array_literal_type_arg_mismatch.voyd"))
    ).toThrow(/type mismatch for __array_new_fixed element/);
  });
});
