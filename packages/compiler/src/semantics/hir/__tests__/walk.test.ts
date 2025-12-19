import { describe, expect, it } from "vitest";
import {
  createHirBuilder,
  walkExpression,
  walkPattern,
  type HirPattern,
  type HirTypeExpr,
} from "../index.js";

const span = { file: "walk.test.voyd", start: 0, end: 1 };

const createTestBuilder = () => {
  let astId = 1;
  const nextAst = () => {
    const current = astId;
    astId += 1;
    return current;
  };
  const builder = createHirBuilder({
    path: "walk.test",
    scope: 0,
    ast: nextAst(),
    span,
  });

  const addLiteral = (value = "0") =>
    builder.addExpression({
      kind: "expr",
      exprKind: "literal",
      ast: nextAst(),
      span,
      literalKind: "i32",
      value,
    });

  const addIdentifier = (symbol: number) =>
    builder.addExpression({
      kind: "expr",
      exprKind: "identifier",
      ast: nextAst(),
      span,
      symbol,
    });

  const addCall = (callee: number, args: readonly number[]) =>
    builder.addExpression({
      kind: "expr",
      exprKind: "call",
      ast: nextAst(),
      span,
      callee,
      args: args.map((expr) => ({ expr })),
    });

  const addExprStmt = (expr: number) =>
    builder.addStatement({
      kind: "expr-stmt",
      ast: nextAst(),
      span,
      expr,
    });

  const addLetStmt = (pattern: HirPattern, initializer: number) =>
    builder.addStatement({
      kind: "let",
      ast: nextAst(),
      span,
      mutable: false,
      pattern,
      initializer,
    });

  const addBlock = (statements: readonly number[], value?: number) =>
    builder.addExpression({
      kind: "expr",
      exprKind: "block",
      ast: nextAst(),
      span,
      statements,
      value,
    });

  const addAssign = (value: number, pattern?: HirPattern, target?: number) =>
    builder.addExpression({
      kind: "expr",
      exprKind: "assign",
      ast: nextAst(),
      span,
      value,
      pattern,
      target,
    });

  const addLambda = (body: number) =>
    builder.addExpression({
      kind: "expr",
      exprKind: "lambda",
      ast: nextAst(),
      span,
      parameters: [],
      body,
      captures: [],
    });

  const addEffectHandler = (
    body: number,
    handlerBody: number,
    finallyBranch?: number
  ) =>
    builder.addExpression({
      kind: "expr",
      exprKind: "effect-handler",
      ast: nextAst(),
      span,
      body,
      handlers: [
        {
          operation: 400,
          resumable: "ctl",
          parameters: [],
          body: handlerBody,
        },
      ],
      finallyBranch,
    });

  return {
    builder,
    nextAst,
    addLiteral,
    addIdentifier,
    addCall,
    addExprStmt,
    addLetStmt,
    addBlock,
    addAssign,
    addLambda,
    addEffectHandler,
  };
};

const createBasicBlock = () => {
  const { builder, addLiteral, addIdentifier, addCall, addExprStmt, addBlock } =
    createTestBuilder();
  const litArg = addLiteral("1");
  const callee = addIdentifier(10);
  const callId = addCall(callee, [litArg]);
  const stmtId = addExprStmt(callId);
  const litValue = addLiteral("2");
  const blockId = addBlock([stmtId], litValue);
  return {
    hir: builder.finalize(),
    blockId,
    callId,
    calleeId: callee,
    litArgId: litArg,
    litValueId: litValue,
    stmtId,
  };
};

describe("hir walk", () => {
  it("walks expressions and statements in enter/exit order", () => {
    const { hir, blockId, callId, calleeId, litArgId, litValueId, stmtId } =
      createBasicBlock();
    const events: string[] = [];

    walkExpression({
      exprId: blockId,
      hir,
      onEnterExpression: (id, expr) => {
        events.push(`enter-expr:${expr.exprKind}:${id}`);
      },
      onExitExpression: (id, expr) => {
        events.push(`exit-expr:${expr.exprKind}:${id}`);
      },
      onEnterStatement: (id, stmt) => {
        events.push(`enter-stmt:${stmt.kind}:${id}`);
      },
      onExitStatement: (id, stmt) => {
        events.push(`exit-stmt:${stmt.kind}:${id}`);
      },
    });

    expect(events).toEqual([
      `enter-expr:block:${blockId}`,
      `enter-stmt:expr-stmt:${stmtId}`,
      `enter-expr:call:${callId}`,
      `enter-expr:identifier:${calleeId}`,
      `exit-expr:identifier:${calleeId}`,
      `enter-expr:literal:${litArgId}`,
      `exit-expr:literal:${litArgId}`,
      `exit-expr:call:${callId}`,
      `exit-stmt:expr-stmt:${stmtId}`,
      `enter-expr:literal:${litValueId}`,
      `exit-expr:literal:${litValueId}`,
      `exit-expr:block:${blockId}`,
    ]);
  });

  it("supports skipChildren for expressions", () => {
    const { hir, blockId, callId, litValueId } = createBasicBlock();
    const visited: number[] = [];

    walkExpression({
      exprId: blockId,
      hir,
      onEnterExpression: (id) => {
        visited.push(id);
        return id === callId ? { skipChildren: true } : undefined;
      },
    });

    expect(visited).toEqual([blockId, callId, litValueId]);
  });

  it("supports stop for expressions", () => {
    const { hir, blockId, callId } = createBasicBlock();
    const visited: number[] = [];

    walkExpression({
      exprId: blockId,
      hir,
      onEnterExpression: (id) => {
        visited.push(id);
        return id === callId ? { stop: true } : undefined;
      },
    });

    expect(visited).toEqual([blockId, callId]);
  });

  it("walks let and assign patterns", () => {
    const {
      builder,
      nextAst,
      addLiteral,
      addAssign,
      addLetStmt,
      addExprStmt,
      addBlock,
    } = createTestBuilder();

    const tuplePattern: HirPattern = {
      kind: "tuple",
      elements: [
        { kind: "identifier", symbol: 2 },
        { kind: "wildcard" },
      ],
    };

    const destructurePattern: HirPattern = {
      kind: "destructure",
      fields: [
        { name: "a", pattern: { kind: "identifier", symbol: 1 } },
        { name: "b", pattern: tuplePattern },
      ],
      spread: { kind: "identifier", symbol: 3 },
    };

    const namedType: HirTypeExpr = {
      typeKind: "named",
      ast: nextAst(),
      span,
      path: ["i32"],
    };

    const typePattern: HirPattern = {
      kind: "type",
      type: namedType,
      binding: { kind: "identifier", symbol: 4 },
    };

    const letInit = addLiteral("0");
    const letStmtId = addLetStmt(destructurePattern, letInit);
    const assignExpr = addAssign(addLiteral("1"), typePattern);
    const assignStmtId = addExprStmt(assignExpr);
    const blockId = addBlock([letStmtId, assignStmtId]);

    const hir = builder.finalize();
    const kinds: string[] = [];

    walkExpression({
      exprId: blockId,
      hir,
      onEnterPattern: (pattern) => {
        kinds.push(pattern.kind);
      },
    });

    expect(kinds).toEqual([
      "destructure",
      "identifier",
      "tuple",
      "identifier",
      "wildcard",
      "identifier",
      "type",
      "identifier",
    ]);
  });

  it("supports skipChildren for patterns", () => {
    const pattern: HirPattern = {
      kind: "destructure",
      fields: [
        { name: "a", pattern: { kind: "identifier", symbol: 1 } },
        {
          name: "b",
          pattern: {
            kind: "tuple",
            elements: [{ kind: "identifier", symbol: 2 }],
          },
        },
      ],
    };
    const kinds: string[] = [];

    walkPattern({
      pattern,
      onEnterPattern: (node) => {
        kinds.push(node.kind);
        return node.kind === "destructure" ? { skipChildren: true } : undefined;
      },
    });

    expect(kinds).toEqual(["destructure"]);
  });

  it("supports skipLambdas", () => {
    const { builder, addIdentifier, addLambda } = createTestBuilder();
    const bodyId = addIdentifier(1);
    const lambdaId = addLambda(bodyId);
    const hir = builder.finalize();
    const identifiers: number[] = [];

    walkExpression({
      exprId: lambdaId,
      hir,
      options: { skipLambdas: true },
      onEnterExpression: (id, expr) => {
        if (expr.exprKind === "identifier") {
          identifiers.push(id);
        }
      },
    });

    expect(identifiers).toEqual([]);
  });

  it("respects visitHandlerBodies", () => {
    const { builder, addIdentifier, addLiteral, addEffectHandler } =
      createTestBuilder();
    const bodyId = addIdentifier(100);
    const handlerBodyId = addIdentifier(200);
    const finallyId = addLiteral("2");
    const handlerId = addEffectHandler(bodyId, handlerBodyId, finallyId);
    const hir = builder.finalize();
    const identifiers: number[] = [];

    walkExpression({
      exprId: handlerId,
      hir,
      options: { visitHandlerBodies: false },
      onEnterExpression: (id, expr) => {
        if (expr.exprKind === "identifier") {
          identifiers.push(id);
        }
      },
    });

    expect(identifiers).toEqual([bodyId]);
  });

  it("supports skipEffectHandlers", () => {
    const { builder, addIdentifier, addEffectHandler } = createTestBuilder();
    const bodyId = addIdentifier(10);
    const handlerBodyId = addIdentifier(20);
    const handlerId = addEffectHandler(bodyId, handlerBodyId);
    const hir = builder.finalize();
    const identifiers: number[] = [];

    walkExpression({
      exprId: handlerId,
      hir,
      options: { skipEffectHandlers: true },
      onEnterExpression: (id, expr) => {
        if (expr.exprKind === "identifier") {
          identifiers.push(id);
        }
      },
    });

    expect(identifiers).toEqual([]);
  });
});
