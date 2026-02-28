import { describe, expect, it } from "vitest";
import { parse } from "../../parser/index.js";
import { getSymbolTable } from "../_internal/symbol-table.js";
import type { SymbolId } from "../ids.js";
import { semanticsPipeline, type SemanticsPipelineResult } from "../pipeline.js";
import {
  buildTypeParamNameIndex,
  typeSummaryForSymbol,
} from "../type-display.js";
import type { HirIdentifierPattern, HirLetStatement } from "../hir/nodes.js";

type TypeDisplayTestContext = {
  semantics: SemanticsPipelineResult;
  semanticsByModule: Map<string, SemanticsPipelineResult>;
};

const createTypeDisplayTestContext = (source: string): TypeDisplayTestContext => {
  const semantics = semanticsPipeline(parse(source, "type_display_test.voyd"));
  return {
    semantics,
    semanticsByModule: new Map([[semantics.moduleId, semantics]]),
  };
};

const rootSymbolNamed = ({
  semantics,
  name,
}: {
  semantics: SemanticsPipelineResult;
  name: string;
}): SymbolId => {
  const symbolTable = getSymbolTable(semantics);
  const symbol = symbolTable.resolve(name, symbolTable.rootScope);
  if (typeof symbol === "number") {
    return symbol;
  }
  throw new Error(`expected root symbol ${name}`);
};

const summaryFor = ({
  context,
  symbol,
  displayName,
}: {
  context: TypeDisplayTestContext;
  symbol: SymbolId;
  displayName?: string;
}): string | undefined => {
  const typeParamNamesByModule = buildTypeParamNameIndex({
    semanticsByModule: context.semanticsByModule,
  });
  return typeSummaryForSymbol({
    ref: { moduleId: context.semantics.moduleId, symbol },
    semanticsByModule: context.semanticsByModule,
    typeParamNamesByModule,
    displayName,
  });
};

describe("type display", () => {
  it("formats generic function signatures", () => {
    const context = createTypeDisplayTestContext(`fn identity<T>(value: T) -> T\n  value\n`);

    const summary = summaryFor({
      context,
      symbol: rootSymbolNamed({
        semantics: context.semantics,
        name: "identity",
      }),
    });

    expect(summary).toBe("fn identity<T>(value: T) -> T");
  });

  it("normalizes optional parameter types back to source-level syntax", () => {
    const context = createTypeDisplayTestContext(
      `obj Some<T> {\n  value: T\n}\n\nobj None {}\n\ntype Optional<T> = Some<T> | None\n\nfn work(id: i32, middle?: i32) -> i32\n  id\n`,
    );

    const workSymbol = rootSymbolNamed({
      semantics: context.semantics,
      name: "work",
    });
    const workDecl = context.semantics.binding.functions.find(
      (entry) => entry.symbol === workSymbol,
    );
    expect(workDecl).toBeDefined();
    if (!workDecl) {
      return;
    }

    const middleParam = workDecl.params.find((param) => param.name === "middle");
    expect(middleParam).toBeDefined();
    if (!middleParam) {
      return;
    }

    expect(
      summaryFor({
        context,
        symbol: workSymbol,
      }),
    ).toBe("fn work(id: i32, middle?: i32) -> i32");

    expect(
      summaryFor({
        context,
        symbol: middleParam.symbol,
      }),
    ).toBe("middle?: i32");
  });

  it("formats inferred local types from function instantiations", () => {
    const context = createTypeDisplayTestContext(
      `fn identity<T>(value: T) -> T\n  let copy = value\n  copy\n\nfn main() -> i32\n  identity(42)\n`,
    );

    const symbolTable = getSymbolTable(context.semantics);
    const copySymbol = Array.from(context.semantics.hir.statements.values())
      .filter((statement): statement is HirLetStatement => statement.kind === "let")
      .map((statement) => statement.pattern)
      .find(
        (pattern): pattern is HirIdentifierPattern =>
          pattern.kind === "identifier" && symbolTable.getSymbol(pattern.symbol).name === "copy",
      )?.symbol;

    expect(copySymbol).toBeDefined();
    if (typeof copySymbol !== "number") {
      return;
    }

    expect(
      summaryFor({
        context,
        symbol: copySymbol,
      }),
    ).toBe("copy: i32");
  });

  it("supports display-name overrides for external labels", () => {
    const context = createTypeDisplayTestContext(
      `fn reduce<T>(value: T, { start: T, reducer cb: (acc: T, current: T) -> T }) -> T\n  cb(start, value)\n`,
    );

    const reduceSymbol = rootSymbolNamed({
      semantics: context.semantics,
      name: "reduce",
    });
    const reduceDecl = context.semantics.binding.functions.find(
      (entry) => entry.symbol === reduceSymbol,
    );
    expect(reduceDecl).toBeDefined();
    if (!reduceDecl) {
      return;
    }

    const reducerParam = reduceDecl.params.find((param) => param.name === "cb");
    expect(reducerParam).toBeDefined();
    if (!reducerParam) {
      return;
    }

    expect(
      summaryFor({
        context,
        symbol: reducerParam.symbol,
        displayName: "reducer",
      }),
    ).toBe("reducer: (T, T) -> T ! open effect row");
  });
});
