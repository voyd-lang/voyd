import { describe, expect, it } from "vitest";
import { semanticsPipeline } from "../../pipeline.js";
import { loadAst } from "../../__tests__/load-ast.js";

describe("nominal objects", () => {
  it("preserves nominal identity while allowing structural use", () => {
    const ast = loadAst("nominal_objects.voyd");
    const { symbolTable, typing, binding } = semanticsPipeline(ast);
    const root = symbolTable.rootScope;

    const vecSymbol = symbolTable.resolve("Vec", root);
    expect(vecSymbol).toBeDefined();
    const vecType = typing.valueTypes.get(vecSymbol!);
    expect(vecType).toBeDefined();

    const vecDesc = typing.arena.get(vecType!);
    expect(vecDesc.kind).toBe("intersection");
    if (vecDesc.kind === "intersection") {
      expect(vecDesc.nominal).toBeDefined();
      expect(vecDesc.structural).toBeDefined();
      const nominalDesc = typing.arena.get(vecDesc.nominal!);
      expect(nominalDesc).toMatchObject({
        kind: "nominal-object",
        owner: expect.objectContaining({ symbol: vecSymbol }),
      });
      const structuralDesc = typing.arena.get(vecDesc.structural!);
      expect(structuralDesc.kind).toBe("structural-object");
    }

    const findSymbol = (name: string) =>
      Array.from(typing.valueTypes.keys()).find(
        (symbol) => {
          const record = symbolTable.getSymbol(symbol);
          return record.name === name && record.kind === "value";
        }
      );

    const aSymbol = findSymbol("a");
    const bSymbol = findSymbol("b");
    expect(aSymbol).toBeDefined();
    expect(bSymbol).toBeDefined();

    const aType = typing.valueTypes.get(aSymbol!);
    const bType = typing.valueTypes.get(bSymbol!);
    expect(aType).toBeDefined();
    expect(bType).toBeDefined();

    if (typeof aType === "number") {
      expect(typing.arena.get(aType).kind).toBe("intersection");
    }
    if (typeof bType === "number") {
      expect(typing.arena.get(bType).kind).toBe("structural-object");
    }
  });
});
