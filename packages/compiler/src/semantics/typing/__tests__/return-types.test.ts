import { describe, expect, it } from "vitest";

import { semanticsPipeline } from "../../pipeline.js";
import { loadAst } from "../../__tests__/load-ast.js";
import { getSymbolTable } from "../../_internal/symbol-table.js";
import { parse } from "../../../parser/index.js";

const nominalNameOf = (
  typeId: number,
  { arena }: Pick<ReturnType<typeof semanticsPipeline>["typing"], "arena">,
): string => {
  const desc = arena.get(typeId);
  if (desc.kind === "nominal-object" && typeof desc.name === "string") {
    return desc.name;
  }
  if (desc.kind === "intersection" && typeof desc.nominal === "number") {
    const nominal = arena.get(desc.nominal);
    if (nominal.kind === "nominal-object") {
      return typeof nominal.name === "string" ? nominal.name : nominal.kind;
    }
  }
  return desc.kind;
};

describe("return type inference", () => {
  it("infers a union when multiple nominal objects are returned", () => {
    const semantics = semanticsPipeline(loadAst("return_union_inference.voyd"));
    const { typing } = semantics;
    const symbolTable = getSymbolTable(semantics);
    const chooseSymbol = symbolTable.resolve("choose", symbolTable.rootScope);
    expect(typeof chooseSymbol).toBe("number");
    if (typeof chooseSymbol !== "number") return;

    const chooseSignature = typing.functions.getSignature(chooseSymbol);
    expect(chooseSignature).toBeDefined();
    if (!chooseSignature) return;

    const returnDesc = typing.arena.get(chooseSignature.returnType);
    expect(returnDesc.kind).toBe("union");
    if (returnDesc.kind !== "union") return;

    const memberNames = returnDesc.members
      .map((member) => nominalNameOf(member, typing))
      .sort();
    expect(memberNames).toEqual(["Other", "Some"]);
  });

  it("preserves finite result identity in typed generic and same-place signatures", () => {
    const semantics = semanticsPipeline(
      parse(
        `@result(detached)
fn relay<T>(value: T) -> i32
  1

@result(fresh)
fn make() -> i32
  1

fn replace(~value: i32) -> ~value
  value

obj Box { value: i32 }

impl Box
  fn reset(~self) -> ~self
    self
`,
        "result-identity.voyd",
      ),
    );
    expect(semantics.diagnostics).toHaveLength(0);
    const symbols = getSymbolTable(semantics);
    const signatureFor = (name: string) => {
      const symbol = symbols.resolve(name, symbols.rootScope);
      expect(typeof symbol).toBe("number");
      return typeof symbol === "number"
        ? semantics.typing.functions.getSignature(symbol)
        : undefined;
    };

    expect(signatureFor("relay")?.resultIdentity).toEqual({
      kind: "detached",
    });
    expect(signatureFor("make")?.resultIdentity).toEqual({ kind: "fresh" });
    const replace = signatureFor("replace");
    expect(replace?.resultIdentity).toEqual({
      kind: "same-place",
      parameterIndex: 0,
    });
    expect(replace?.returnType).toBe(replace?.parameters[0]?.type);

    const resetFunction = Array.from(semantics.hir.items.values()).find(
      (item) =>
        item.kind === "function" &&
        symbols.getSymbol(item.symbol).name === "reset",
    );
    expect(resetFunction?.kind).toBe("function");
    if (resetFunction?.kind !== "function") return;
    const reset = semantics.typing.functions.getSignature(resetFunction.symbol);
    expect(reset?.resultIdentity).toEqual({
      kind: "same-place",
      parameterIndex: 0,
    });
    expect(reset?.returnType).toBe(reset?.parameters[0]?.type);
  });

  it("preserves result identity on trait method HIR", () => {
    const semantics = semanticsPipeline(
      parse(
        `trait Factory<T>
  @result(fresh)
  fn make(value: T) -> T
`,
        "trait-result-identity.voyd",
      ),
    );
    const trait = Array.from(semantics.hir.items.values()).find(
      (item) => item.kind === "trait",
    );
    expect(trait?.kind).toBe("trait");
    if (trait?.kind !== "trait") return;
    expect(trait.methods[0]?.resultIdentity).toEqual({ kind: "fresh" });
  });

  it("rejects a same-place return whose parameter type is unknown", () => {
    expect(() =>
      semanticsPipeline(
        parse(
          `fn bad(~value) -> ~value
  value
`,
          "unknown-same-place-result.voyd",
        ),
      ),
    ).toThrow(/must have a known type/);
  });
});
