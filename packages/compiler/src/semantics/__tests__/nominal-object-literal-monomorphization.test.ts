import { describe, expect, it } from "vitest";
import type { ModuleGraph, ModuleNode, ModulePath } from "../../modules/types.js";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../pipeline.js";
import { buildProgramCodegenView } from "../codegen-view/index.js";
import { monomorphizeProgram } from "../linking.js";
import { getSymbolTable } from "../_internal/symbol-table.js";
import type { HirCallExpr, HirIdentifierExpr } from "../hir/index.js";

const buildSemantics = ({
  source,
  filePath,
}: {
  source: string;
  filePath: string;
}) => {
  const form = parse(source, filePath);
  const path: ModulePath = { namespace: "src", segments: [] };
  const module: ModuleNode = {
    id: filePath,
    path,
    origin: { kind: "file", filePath },
    ast: form,
    source,
    dependencies: [],
  };
  const graph: ModuleGraph = {
    entry: module.id,
    modules: new Map([[module.id, module]]),
    diagnostics: [],
  };
  return semanticsPipeline({
    module,
    graph,
    exports: new Map(),
    dependencies: new Map(),
  });
};

describe("nominal object literal monomorphization", () => {
  it("does not cache unspecialized field expression types for explicit generic object args", () => {
    const semantics = buildSemantics({
      filePath: "object_literal_cache.voyd",
      source: `obj Box<T> { value: T }

fn hold<T>(value: T) -> T
  value

fn wrap<T>(value: T) -> Box<T>
  Box<T> { value: hold(value) }

pub fn main() -> bool
  wrap(true).value`,
    });

    const symbolTable = getSymbolTable(semantics);
    const wrapSymbol = symbolTable.resolve("wrap", symbolTable.rootScope);
    const holdSymbol = symbolTable.resolve("hold", symbolTable.rootScope);
    expect(typeof wrapSymbol).toBe("number");
    expect(typeof holdSymbol).toBe("number");
    if (typeof wrapSymbol !== "number" || typeof holdSymbol !== "number") {
      return;
    }

    const holdCall = Array.from(semantics.hir.expressions.values()).find(
      (expr): expr is HirCallExpr => {
        if (expr.exprKind !== "call") {
          return false;
        }
        const callee = semantics.hir.expressions.get(expr.callee);
        return (
          callee?.exprKind === "identifier" &&
          (callee as HirIdentifierExpr).symbol === holdSymbol
        );
      }
    );
    expect(holdCall).toBeDefined();
    if (!holdCall) {
      return;
    }

    const modules = [semantics];
    const monomorphized = monomorphizeProgram({
      modules,
      semantics: new Map([[semantics.moduleId, semantics]]),
    });
    const program = buildProgramCodegenView(modules, {
      instances: monomorphized.instances,
      moduleTyping: monomorphized.moduleTyping,
    });

    const boolId = program.primitives.bool;
    const wrapInstanceId = program.functions.getInstanceId(
      semantics.moduleId,
      wrapSymbol,
      [boolId]
    );
    expect(typeof wrapInstanceId).toBe("number");
    if (typeof wrapInstanceId !== "number") {
      return;
    }

    expect(
      program.functions.getInstanceExprType(wrapInstanceId, holdCall.id)
    ).toBe(boolId);
  });
});
