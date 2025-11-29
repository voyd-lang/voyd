import { SymbolTable } from "../../binder/index.js";
import { createHirBuilder } from "../../hir/index.js";
import type {
  HirExprId,
  HirStmtId,
  NodeId,
  SourceSpan,
  SymbolId,
} from "../../ids.js";
import type { HirLiteralExpr, HirNamedTypeExpr } from "../../hir/nodes.js";
import { DeclTable } from "../../decls.js";
import type { ScopeId } from "../../ids.js";
import { Expr } from "../../../parser/index.js";

const createSpan = (): SourceSpan => ({ file: "test.voyd", start: 0, end: 0 });

export interface TestModuleContext {
  symbolTable: SymbolTable;
  builder: ReturnType<typeof createHirBuilder>;
  decls: DeclTable;
  span: SourceSpan;
  nextModuleIndex(): number;
  nextNode(): NodeId;
  createLiteral(
    literalKind: HirLiteralExpr["literalKind"],
    value: string
  ): HirExprId;
  createReturn(value?: HirExprId): HirStmtId;
  createBlock(statements: readonly HirStmtId[], value?: HirExprId): HirExprId;
  addFunction(
    symbol: SymbolId,
    body: HirExprId,
    returnType?: HirNamedTypeExpr
  ): void;
}

export const createModuleContext = (): TestModuleContext => {
  let nextNodeId: NodeId = 1;
  let nextModuleIndex = 0;
  const nextNode = (): NodeId => nextNodeId++;
  const takeModuleIndex = (): number => nextModuleIndex++;
  const span = createSpan();
  const symbolTable = new SymbolTable({ rootOwner: 0 });
  const moduleSymbol = symbolTable.declare({
    name: "test",
    kind: "module",
    declaredAt: nextNode(),
  });

  const builder = createHirBuilder({
    path: span.file,
    scope: moduleSymbol,
    ast: 0,
    span,
  });
  const decls = new DeclTable();

  const createLiteral = (
    literalKind: HirLiteralExpr["literalKind"],
    value: string
  ): HirExprId =>
    builder.addExpression({
      kind: "expr",
      exprKind: "literal",
      literalKind,
      value,
      ast: nextNode(),
      span,
    });

  const createReturn = (value?: HirExprId): HirStmtId =>
    builder.addStatement({
      kind: "return",
      value,
      ast: nextNode(),
      span,
    });

  const createBlock = (
    statements: readonly HirStmtId[],
    value?: HirExprId
  ): HirExprId =>
    builder.addExpression({
      kind: "expr",
      exprKind: "block",
      statements,
      value,
      ast: nextNode(),
      span,
    });

  const addFunction = (
    symbol: SymbolId,
    body: HirExprId,
    returnType?: HirNamedTypeExpr
  ): void => {
    const name = symbolTable.getSymbol(symbol).name;
    const fakeExpr = {
      syntaxId: nextNode(),
      location: span,
    } as unknown as Expr;
    const functionScope = symbolTable.rootScope as ScopeId;
    const moduleIndex = takeModuleIndex();
    const registered = decls.registerFunction({
      id: moduleIndex,
      name,
      form: undefined,
      visibility: "module",
      symbol,
      scope: functionScope,
      params: [],
      body: fakeExpr,
      moduleIndex,
    });

    builder.addFunction({
      kind: "function",
      visibility: "module",
      symbol,
      decl: registered.id,
      parameters: [],
      returnType,
      body,
      ast: nextNode(),
      span,
    });
  };

  return {
    symbolTable,
    builder,
    span,
    nextModuleIndex: takeModuleIndex,
    nextNode,
    createLiteral,
    createReturn,
    createBlock,
    decls,
    addFunction,
  };
};
