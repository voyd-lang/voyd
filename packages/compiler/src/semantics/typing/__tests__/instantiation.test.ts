import { describe, expect, it } from "vitest";
import { SymbolTable } from "../../binder/index.js";
import { createTypingContext, createTypingState } from "../context.js";
import { seedBaseObjectType, seedPrimitiveTypes } from "../registry.js";
import {
  ensureObjectType,
  getObjectTemplate,
  getStructuralFields,
  resolveTypeAlias,
  typeSatisfies,
} from "../type-system.js";
import { DeclTable } from "../../decls.js";
import type { HirGraph, HirTypeExpr } from "../../hir/index.js";
import type { SourceSpan, SymbolId, TypeId } from "../../ids.js";

const DUMMY_SPAN: SourceSpan = { file: "<test>", start: 0, end: 0 };

const createContext = () => {
  const symbolTable = new SymbolTable({ rootOwner: 0 });
  const hir: HirGraph = {
    module: {
      kind: "module",
      id: 0,
      path: "<test>",
      scope: symbolTable.rootScope,
      ast: 0,
      span: DUMMY_SPAN,
      items: [],
      exports: [],
    },
    items: new Map(),
    statements: new Map(),
    expressions: new Map(),
  };
  const ctx = createTypingContext({
    symbolTable,
    hir,
    overloads: new Map(),
    decls: new DeclTable(),
    moduleId: "test",
  });
  seedPrimitiveTypes(ctx);
  seedBaseObjectType(ctx);
  const state = createTypingState();
  return { ctx, state, symbolTable };
};

const unfoldRecursiveType = (
  typeId: TypeId,
  arena: ReturnType<typeof createContext>["ctx"]["arena"]
): TypeId => {
  const desc = arena.get(typeId);
  if (desc.kind !== "recursive") {
    return typeId;
  }
  return arena.substitute(desc.body, new Map([[desc.binder, typeId]]));
};

const primeBoxTemplate = (
  ctx: ReturnType<typeof createContext>["ctx"],
  symbolTable: SymbolTable,
  constraint?: TypeId
) => {
  const typeParamSymbol = symbolTable.declare({
    name: "T",
    kind: "type",
    declaredAt: 0,
  });
  const boxSymbol = symbolTable.declare({
    name: "Box",
    kind: "type",
    declaredAt: 0,
  });
  const typeParam = ctx.arena.freshTypeParam();
  const typeParamRef = ctx.arena.internTypeParamRef(typeParam);
  const fields = [
    { name: "value", type: typeParamRef, declaringParams: [typeParam] },
  ];
  const structural = ctx.arena.internStructuralObject({ fields });
  const nominal = ctx.arena.internNominalObject({
    owner: { moduleId: "test", symbol: boxSymbol },
    name: "Box",
    typeArgs: [typeParamRef],
  });
  const type = ctx.arena.internIntersection({ nominal, structural });
  ctx.objects.registerTemplate({
    symbol: boxSymbol,
    params: [{ symbol: typeParamSymbol, typeParam, constraint }],
    nominal,
    structural,
    type,
    fields,
    baseNominal: undefined,
  });
  ctx.objects.setName("Box", boxSymbol);
  return { boxSymbol };
};

const primeSomeTemplate = (
  ctx: ReturnType<typeof createContext>["ctx"],
  symbolTable: SymbolTable
) => {
  const typeParamSymbol = symbolTable.declare({
    name: "U",
    kind: "type",
    declaredAt: 0,
  });
  const someSymbol = symbolTable.declare({
    name: "Some",
    kind: "type",
    declaredAt: 0,
  });
  const typeParam = ctx.arena.freshTypeParam();
  const typeParamRef = ctx.arena.internTypeParamRef(typeParam);
  const fields = [
    { name: "value", type: typeParamRef, declaringParams: [typeParam] },
  ];
  const structural = ctx.arena.internStructuralObject({ fields });
  const nominal = ctx.arena.internNominalObject({
    owner: { moduleId: "test", symbol: someSymbol },
    name: "Some",
    typeArgs: [typeParamRef],
  });
  const type = ctx.arena.internIntersection({ nominal, structural });
  ctx.objects.registerTemplate({
    symbol: someSymbol,
    params: [{ symbol: typeParamSymbol, typeParam }],
    nominal,
    structural,
    type,
    fields,
    baseNominal: undefined,
  });
  ctx.objects.setName("Some", someSymbol);
  return { someSymbol, valueParam: typeParam };
};

const primeNoneTemplate = (
  ctx: ReturnType<typeof createContext>["ctx"],
  symbolTable: SymbolTable
) => {
  const typeParamSymbol = symbolTable.declare({
    name: "T",
    kind: "type",
    declaredAt: 0,
  });
  const noneSymbol = symbolTable.declare({
    name: "None",
    kind: "type",
    declaredAt: 0,
  });
  const typeParam = ctx.arena.freshTypeParam();
  const typeParamRef = ctx.arena.internTypeParamRef(typeParam);
  const structural = ctx.arena.internStructuralObject({ fields: [] });
  const nominal = ctx.arena.internNominalObject({
    owner: { moduleId: "test", symbol: noneSymbol },
    name: "None",
    typeArgs: [typeParamRef],
  });
  const type = ctx.arena.internIntersection({ nominal, structural });
  ctx.objects.registerTemplate({
    symbol: noneSymbol,
    params: [{ symbol: typeParamSymbol, typeParam }],
    nominal,
    structural,
    type,
    fields: [],
    baseNominal: undefined,
  });
  ctx.objects.setName("None", noneSymbol);
  return { noneSymbol };
};

const primeBucketMapTemplate = (
  ctx: ReturnType<typeof createContext>["ctx"],
  symbolTable: SymbolTable,
  someSymbol: SymbolId
) => {
  const keyParamSymbol = symbolTable.declare({
    name: "K",
    kind: "type",
    declaredAt: 0,
  });
  const valueParamSymbol = symbolTable.declare({
    name: "V",
    kind: "type",
    declaredAt: 0,
  });
  const mapSymbol = symbolTable.declare({
    name: "BucketMap",
    kind: "type",
    declaredAt: 0,
  });
  const keyParam = ctx.arena.freshTypeParam();
  const valueParam = ctx.arena.freshTypeParam();
  const keyRef = ctx.arena.internTypeParamRef(keyParam);
  const valueRef = ctx.arena.internTypeParamRef(valueParam);
  const payload = ctx.arena.internNominalObject({
    owner: { moduleId: "test", symbol: someSymbol },
    name: "Some",
    typeArgs: [valueRef],
  });
  const fields = [
    { name: "bucketKey", type: keyRef, declaringParams: [keyParam] },
    { name: "payload", type: payload, declaringParams: [valueParam] },
  ];
  const structural = ctx.arena.internStructuralObject({ fields });
  const nominal = ctx.arena.internNominalObject({
    owner: { moduleId: "test", symbol: mapSymbol },
    name: "BucketMap",
    typeArgs: [keyRef, valueRef],
  });
  const type = ctx.arena.internIntersection({ nominal, structural });
  ctx.objects.registerTemplate({
    symbol: mapSymbol,
    params: [
      { symbol: keyParamSymbol, typeParam: keyParam },
      { symbol: valueParamSymbol, typeParam: valueParam },
    ],
    nominal,
    structural,
    type,
    fields,
    baseNominal: undefined,
  });
  ctx.objects.setName("BucketMap", mapSymbol);
  return { mapSymbol, valueParam };
};

const primeAliasTemplate = (
  ctx: ReturnType<typeof createContext>["ctx"],
  symbolTable: SymbolTable,
  options: { constraint?: HirTypeExpr } = {}
) => {
  const paramSymbol = symbolTable.declare({
    name: "U",
    kind: "type",
    declaredAt: 0,
  });
  const aliasSymbol = symbolTable.declare({
    name: "Wrap",
    kind: "type",
    declaredAt: 0,
  });
  const target: HirTypeExpr = {
    typeKind: "named",
    path: ["U"],
    symbol: paramSymbol,
    ast: 0,
    span: DUMMY_SPAN,
  };
  ctx.typeAliases.registerTemplate({
    symbol: aliasSymbol,
    params: [{ symbol: paramSymbol, constraint: options.constraint }],
    target,
  });
  return { aliasSymbol };
};

describe("instantiation argument handling", () => {
  it("does not cache unknown object instantiations", () => {
    const { ctx, state, symbolTable } = createContext();
    const { boxSymbol } = primeBoxTemplate(ctx, symbolTable);
    const unknownKey = `${boxSymbol}<${ctx.primitives.unknown}>`;

    const info = ensureObjectType(boxSymbol, ctx, state, [
      ctx.primitives.unknown,
    ]);
    expect(info).toBeDefined();
    expect(ctx.objects.hasInstance(unknownKey)).toBe(false);
    expect(ctx.objects.hasNominal(info?.nominal ?? -1)).toBe(false);
    expect(ctx.valueTypes.has(boxSymbol)).toBe(false);

    const boolKey = `${boxSymbol}<${ctx.primitives.bool}>`;
    const concrete = ensureObjectType(boxSymbol, ctx, state, [
      ctx.primitives.bool,
    ]);
    expect(ctx.objects.getInstance(boolKey)).toEqual(concrete);
    expect(ctx.valueTypes.get(boxSymbol)).toBe(concrete?.type);
  });

  it("throws for missing object type arguments in strict mode", () => {
    const { ctx, state, symbolTable } = createContext();
    const { boxSymbol } = primeBoxTemplate(ctx, symbolTable);
    state.mode = "strict";
    expect(() => ensureObjectType(boxSymbol, ctx, state, [])).toThrow(
      /missing 1 type argument/
    );
  });

  it("fails when alias arguments are missing", () => {
    const { ctx, state, symbolTable } = createContext();
    const { aliasSymbol } = primeAliasTemplate(ctx, symbolTable);

    expect(() => resolveTypeAlias(aliasSymbol, ctx, state, [])).toThrow(
      /missing 1 type argument/
    );

    state.mode = "strict";
    expect(() => resolveTypeAlias(aliasSymbol, ctx, state, [])).toThrow(
      /missing 1 type argument/
    );
    expect(ctx.typeAliases.instanceCount()).toBe(0);
  });

  it("rejects aliases that resolve directly to themselves", () => {
    const { ctx, state, symbolTable } = createContext();
    const aliasSymbol = symbolTable.declare({
      name: "Loop",
      kind: "type",
      declaredAt: 0,
    });
    const target: HirTypeExpr = {
      typeKind: "named",
      path: ["Loop"],
      symbol: aliasSymbol,
      ast: 0,
      span: DUMMY_SPAN,
    };
    ctx.typeAliases.registerTemplate({
      symbol: aliasSymbol,
      params: [],
      target,
    });

    expect(() => resolveTypeAlias(aliasSymbol, ctx, state, [])).toThrow(
      /cannot resolve to itself/
    );
    expect(ctx.typeAliases.instanceCount()).toBe(0);
    expect(ctx.typeAliases.hasFailed(`${aliasSymbol}<>`)).toBe(true);
  });

  it("rejects pure alias cycles", () => {
    const { ctx, state, symbolTable } = createContext();
    const aSymbol = symbolTable.declare({
      name: "A",
      kind: "type",
      declaredAt: 0,
    });
    const bSymbol = symbolTable.declare({
      name: "B",
      kind: "type",
      declaredAt: 0,
    });

    const aTarget: HirTypeExpr = {
      typeKind: "named",
      path: ["B"],
      symbol: bSymbol,
      ast: 0,
      span: DUMMY_SPAN,
    };
    const bTarget: HirTypeExpr = {
      typeKind: "named",
      path: ["A"],
      symbol: aSymbol,
      ast: 0,
      span: DUMMY_SPAN,
    };

    ctx.typeAliases.registerTemplate({
      symbol: aSymbol,
      params: [],
      target: aTarget,
    });
    ctx.typeAliases.registerTemplate({
      symbol: bSymbol,
      params: [],
      target: bTarget,
    });

    expect(() => resolveTypeAlias(aSymbol, ctx, state, [])).toThrow(
      /cyclic type alias instantiation/
    );
    expect(ctx.typeAliases.instanceCount()).toBe(0);
    expect(ctx.typeAliases.hasFailed(`${aSymbol}<>`)).toBe(true);
  });

  it("rejects generic alias cycles", () => {
    const { ctx, state, symbolTable } = createContext();
    const aParamSymbol = symbolTable.declare({
      name: "T",
      kind: "type",
      declaredAt: 0,
    });
    const bParamSymbol = symbolTable.declare({
      name: "U",
      kind: "type",
      declaredAt: 0,
    });
    const aSymbol = symbolTable.declare({
      name: "A",
      kind: "type",
      declaredAt: 0,
    });
    const bSymbol = symbolTable.declare({
      name: "B",
      kind: "type",
      declaredAt: 0,
    });

    const aTarget: HirTypeExpr = {
      typeKind: "named",
      path: ["B"],
      symbol: bSymbol,
      typeArguments: [
        {
          typeKind: "named",
          path: ["T"],
          symbol: aParamSymbol,
          ast: 0,
          span: DUMMY_SPAN,
        },
      ],
      ast: 0,
      span: DUMMY_SPAN,
    };
    const bTarget: HirTypeExpr = {
      typeKind: "named",
      path: ["A"],
      symbol: aSymbol,
      typeArguments: [
        {
          typeKind: "named",
          path: ["U"],
          symbol: bParamSymbol,
          ast: 0,
          span: DUMMY_SPAN,
        },
      ],
      ast: 0,
      span: DUMMY_SPAN,
    };

    ctx.typeAliases.registerTemplate({
      symbol: aSymbol,
      params: [{ symbol: aParamSymbol }],
      target: aTarget,
    });
    ctx.typeAliases.registerTemplate({
      symbol: bSymbol,
      params: [{ symbol: bParamSymbol }],
      target: bTarget,
    });

    const boolType = ctx.primitives.cache.get("bool") ?? ctx.arena.internPrimitive("bool");

    expect(() => resolveTypeAlias(aSymbol, ctx, state, [boolType])).toThrow(
      /cyclic type alias instantiation/
    );
    expect(ctx.typeAliases.instanceCount()).toBe(0);
    expect(ctx.typeAliases.hasFailed(`${aSymbol}<${boolType}>`)).toBe(
      true
    );
  });

  it("rejects non-contractive self recursion in aliases", () => {
    const { ctx, state, symbolTable } = createContext();
    const aliasSymbol = symbolTable.declare({
      name: "Loop",
      kind: "type",
      declaredAt: 0,
    });
    const aliasRef: HirTypeExpr = {
      typeKind: "named",
      path: ["Loop"],
      symbol: aliasSymbol,
      ast: 0,
      span: DUMMY_SPAN,
    };
    const target: HirTypeExpr = {
      typeKind: "union",
      members: [
        aliasRef,
        {
          typeKind: "named",
          path: ["i32"],
          ast: 0,
          span: DUMMY_SPAN,
        },
      ],
      ast: 0,
      span: DUMMY_SPAN,
    };

    ctx.typeAliases.registerTemplate({
      symbol: aliasSymbol,
      params: [],
      target,
    });

    expect(() => resolveTypeAlias(aliasSymbol, ctx, state, [])).toThrow();
    expect(ctx.typeAliases.instanceCount()).toBe(0);
  });

  it("rejects non-contractive generic alias recursion", () => {
    const { ctx, state, symbolTable } = createContext();
    const { boxSymbol } = primeBoxTemplate(ctx, symbolTable);
    const paramSymbol = symbolTable.declare({
      name: "T",
      kind: "type",
      declaredAt: 0,
    });
    const aliasSymbol = symbolTable.declare({
      name: "GenLoop",
      kind: "type",
      declaredAt: 0,
    });
    const paramRef: HirTypeExpr = {
      typeKind: "named",
      path: ["T"],
      symbol: paramSymbol,
      ast: 0,
      span: DUMMY_SPAN,
    };
    const aliasRef: HirTypeExpr = {
      typeKind: "named",
      path: ["GenLoop"],
      symbol: aliasSymbol,
      typeArguments: [paramRef],
      ast: 0,
      span: DUMMY_SPAN,
    };
    const boxedParam: HirTypeExpr = {
      typeKind: "named",
      path: ["Box"],
      symbol: boxSymbol,
      typeArguments: [paramRef],
      ast: 0,
      span: DUMMY_SPAN,
    };
    const target: HirTypeExpr = {
      typeKind: "union",
      members: [aliasRef, boxedParam],
      ast: 0,
      span: DUMMY_SPAN,
    };

    ctx.typeAliases.registerTemplate({
      symbol: aliasSymbol,
      params: [{ symbol: paramSymbol }],
      target,
    });

    expect(() => resolveTypeAlias(aliasSymbol, ctx, state, [ctx.primitives.bool])).toThrow(
      /contractive/i
    );
    expect(ctx.typeAliases.instanceCount()).toBe(0);
  });

  it("rejects mutual generic recursion without guards", () => {
    const { ctx, state, symbolTable } = createContext();
    const leftParamSymbol = symbolTable.declare({
      name: "L",
      kind: "type",
      declaredAt: 0,
    });
    const rightParamSymbol = symbolTable.declare({
      name: "R",
      kind: "type",
      declaredAt: 0,
    });
    const leftSymbol = symbolTable.declare({
      name: "Left",
      kind: "type",
      declaredAt: 0,
    });
    const rightSymbol = symbolTable.declare({
      name: "Right",
      kind: "type",
      declaredAt: 0,
    });

    const leftParamRef: HirTypeExpr = {
      typeKind: "named",
      path: ["L"],
      symbol: leftParamSymbol,
      ast: 0,
      span: DUMMY_SPAN,
    };
    const rightParamRef: HirTypeExpr = {
      typeKind: "named",
      path: ["R"],
      symbol: rightParamSymbol,
      ast: 0,
      span: DUMMY_SPAN,
    };

    const leftTarget: HirTypeExpr = {
      typeKind: "named",
      path: ["Right"],
      symbol: rightSymbol,
      typeArguments: [leftParamRef],
      ast: 0,
      span: DUMMY_SPAN,
    };

    const rightTarget: HirTypeExpr = {
      typeKind: "named",
      path: ["Left"],
      symbol: leftSymbol,
      typeArguments: [rightParamRef],
      ast: 0,
      span: DUMMY_SPAN,
    };

    ctx.typeAliases.registerTemplate({
      symbol: leftSymbol,
      params: [{ symbol: leftParamSymbol }],
      target: leftTarget,
    });
    ctx.typeAliases.registerTemplate({
      symbol: rightSymbol,
      params: [{ symbol: rightParamSymbol }],
      target: rightTarget,
    });

    expect(() => resolveTypeAlias(leftSymbol, ctx, state, [ctx.primitives.bool])).toThrow(
      /contractive|cyclic/i
    );
    expect(ctx.typeAliases.instanceCount()).toBe(0);
  });

  it("resolves recursive aliases through constructors", () => {
    const { ctx, state, symbolTable } = createContext();
    const { boxSymbol } = primeBoxTemplate(ctx, symbolTable);
    const aliasSymbol = symbolTable.declare({
      name: "Rec",
      kind: "type",
      declaredAt: 0,
    });
    const aliasRef: HirTypeExpr = {
      typeKind: "named",
      path: ["Rec"],
      symbol: aliasSymbol,
      ast: 0,
      span: DUMMY_SPAN,
    };
    const boxedAlias: HirTypeExpr = {
      typeKind: "named",
      path: ["Box"],
      symbol: boxSymbol,
      typeArguments: [aliasRef],
      ast: 0,
      span: DUMMY_SPAN,
    };
    const target: HirTypeExpr = {
      typeKind: "union",
      members: [
        boxedAlias,
        {
          typeKind: "named",
          path: ["i32"],
          ast: 0,
          span: DUMMY_SPAN,
        },
      ],
      ast: 0,
      span: DUMMY_SPAN,
    };

    ctx.typeAliases.registerTemplate({
      symbol: aliasSymbol,
      params: [],
      target,
    });

    const resolved = resolveTypeAlias(aliasSymbol, ctx, state, []);
    const desc = ctx.arena.get(unfoldRecursiveType(resolved, ctx.arena));
    expect(desc.kind).toBe("union");
    if (desc.kind !== "union") {
      return;
    }
    const boxedMember = desc.members.find((member) => {
      const memberDesc = ctx.arena.get(member);
      if (memberDesc.kind === "intersection" && typeof memberDesc.nominal === "number") {
        const nominalDesc = ctx.arena.get(memberDesc.nominal);
        return (
          nominalDesc.kind === "nominal-object" &&
          nominalDesc.owner.symbol === boxSymbol
        );
      }
      if (memberDesc.kind === "nominal-object") {
        return memberDesc.owner.symbol === boxSymbol;
      }
      return false;
    });
    expect(boxedMember).toBeDefined();
    expect(resolveTypeAlias(aliasSymbol, ctx, state, [])).toBe(resolved);
  });

  it("resolves mutually recursive aliases", () => {
    const { ctx, state, symbolTable } = createContext();
    const { boxSymbol } = primeBoxTemplate(ctx, symbolTable);
    const leftSymbol = symbolTable.declare({
      name: "Left",
      kind: "type",
      declaredAt: 0,
    });
    const rightSymbol = symbolTable.declare({
      name: "Right",
      kind: "type",
      declaredAt: 0,
    });
    const leftBase: HirTypeExpr = {
      typeKind: "named",
      path: ["i32"],
      ast: 0,
      span: DUMMY_SPAN,
    };
    const leftTarget: HirTypeExpr = {
      typeKind: "union",
      members: [
        {
          typeKind: "named",
          path: ["Right"],
          symbol: rightSymbol,
          ast: 0,
          span: DUMMY_SPAN,
        },
        leftBase,
      ],
      ast: 0,
      span: DUMMY_SPAN,
    };
    const boxedLeft: HirTypeExpr = {
      typeKind: "named",
      path: ["Box"],
      symbol: boxSymbol,
      typeArguments: [
        {
          typeKind: "named",
          path: ["Left"],
          symbol: leftSymbol,
          ast: 0,
          span: DUMMY_SPAN,
        },
      ],
      ast: 0,
      span: DUMMY_SPAN,
    };
    const rightTarget: HirTypeExpr = {
      typeKind: "union",
      members: [
        boxedLeft,
        {
          typeKind: "named",
          path: ["bool"],
          ast: 0,
          span: DUMMY_SPAN,
        },
      ],
      ast: 0,
      span: DUMMY_SPAN,
    };

    ctx.typeAliases.registerTemplate({
      symbol: leftSymbol,
      params: [],
      target: leftTarget,
    });
    ctx.typeAliases.registerTemplate({
      symbol: rightSymbol,
      params: [],
      target: rightTarget,
    });

    const leftAlias = resolveTypeAlias(leftSymbol, ctx, state, []);
    const rightAlias = resolveTypeAlias(rightSymbol, ctx, state, []);

    expect(ctx.typeAliases.getCachedInstance(`${leftSymbol}<>`)).toBe(leftAlias);
    expect(ctx.typeAliases.getCachedInstance(`${rightSymbol}<>`)).toBe(rightAlias);

    const leftDesc = ctx.arena.get(unfoldRecursiveType(leftAlias, ctx.arena));
    const rightDesc = ctx.arena.get(unfoldRecursiveType(rightAlias, ctx.arena));
    expect(leftDesc.kind).toBe("union");
    expect(rightDesc.kind).toBe("union");
    if (rightDesc.kind === "union") {
      const hasBoxedLeft = rightDesc.members.some((member) => {
        const memberDesc = ctx.arena.get(member);
        if (memberDesc.kind === "intersection" && typeof memberDesc.nominal === "number") {
          const nominalDesc = ctx.arena.get(memberDesc.nominal);
          return (
            nominalDesc.kind === "nominal-object" &&
            nominalDesc.owner.symbol === boxSymbol
          );
        }
        if (memberDesc.kind === "nominal-object") {
          return memberDesc.owner.symbol === boxSymbol;
        }
        return false;
      });
      expect(hasBoxedLeft).toBe(true);
    }
  });

  it("supports generic recursive aliases with explicit self arguments", () => {
    const { ctx, state, symbolTable } = createContext();
    const { boxSymbol } = primeBoxTemplate(ctx, symbolTable);
    const typeParamSymbol = symbolTable.declare({
      name: "T",
      kind: "type",
      declaredAt: 0,
    });
    const listSymbol = symbolTable.declare({
      name: "List",
      kind: "type",
      declaredAt: 0,
    });
    const paramRef: HirTypeExpr = {
      typeKind: "named",
      path: ["T"],
      symbol: typeParamSymbol,
      ast: 0,
      span: DUMMY_SPAN,
    };
    const listSelf: HirTypeExpr = {
      typeKind: "named",
      path: ["List"],
      symbol: listSymbol,
      typeArguments: [paramRef],
      ast: 0,
      span: DUMMY_SPAN,
    };
    const boxedList: HirTypeExpr = {
      typeKind: "named",
      path: ["Box"],
      symbol: boxSymbol,
      typeArguments: [listSelf],
      ast: 0,
      span: DUMMY_SPAN,
    };
    const target: HirTypeExpr = {
      typeKind: "union",
      members: [boxedList, paramRef],
      ast: 0,
      span: DUMMY_SPAN,
    };

    ctx.typeAliases.registerTemplate({
      symbol: listSymbol,
      params: [{ symbol: typeParamSymbol }],
      target,
    });

    const resolved = resolveTypeAlias(listSymbol, ctx, state, [ctx.primitives.bool]);
    const key = `${listSymbol}<${ctx.primitives.bool}>`;
    expect(ctx.typeAliases.getCachedInstance(key)).toBe(resolved);
    const desc = ctx.arena.get(unfoldRecursiveType(resolved, ctx.arena));
    expect(desc.kind).toBe("union");
  });

  it("resolves mutually recursive generic aliases", () => {
    const { ctx, state, symbolTable } = createContext();
    const { boxSymbol } = primeBoxTemplate(ctx, symbolTable);
    const leftParamSymbol = symbolTable.declare({
      name: "L",
      kind: "type",
      declaredAt: 0,
    });
    const rightParamSymbol = symbolTable.declare({
      name: "R",
      kind: "type",
      declaredAt: 0,
    });
    const leftSymbol = symbolTable.declare({
      name: "Left",
      kind: "type",
      declaredAt: 0,
    });
    const rightSymbol = symbolTable.declare({
      name: "Right",
      kind: "type",
      declaredAt: 0,
    });

    const leftParamRef: HirTypeExpr = {
      typeKind: "named",
      path: ["L"],
      symbol: leftParamSymbol,
      ast: 0,
      span: DUMMY_SPAN,
    };
    const rightParamRef: HirTypeExpr = {
      typeKind: "named",
      path: ["R"],
      symbol: rightParamSymbol,
      ast: 0,
      span: DUMMY_SPAN,
    };
    const rightOfLeft: HirTypeExpr = {
      typeKind: "named",
      path: ["Right"],
      symbol: rightSymbol,
      typeArguments: [leftParamRef],
      ast: 0,
      span: DUMMY_SPAN,
    };
    const leftTarget: HirTypeExpr = {
      typeKind: "union",
      members: [rightOfLeft, leftParamRef],
      ast: 0,
      span: DUMMY_SPAN,
    };

    const leftOfRight: HirTypeExpr = {
      typeKind: "named",
      path: ["Left"],
      symbol: leftSymbol,
      typeArguments: [rightParamRef],
      ast: 0,
      span: DUMMY_SPAN,
    };
    const boxedLeft: HirTypeExpr = {
      typeKind: "named",
      path: ["Box"],
      symbol: boxSymbol,
      typeArguments: [leftOfRight],
      ast: 0,
      span: DUMMY_SPAN,
    };
    const rightTarget: HirTypeExpr = {
      typeKind: "union",
      members: [
        boxedLeft,
        {
          typeKind: "named",
          path: ["bool"],
          ast: 0,
          span: DUMMY_SPAN,
        },
      ],
      ast: 0,
      span: DUMMY_SPAN,
    };

    ctx.typeAliases.registerTemplate({
      symbol: leftSymbol,
      params: [{ symbol: leftParamSymbol }],
      target: leftTarget,
    });
    ctx.typeAliases.registerTemplate({
      symbol: rightSymbol,
      params: [{ symbol: rightParamSymbol }],
      target: rightTarget,
    });

    const intType =
      ctx.primitives.cache.get("i32") ?? ctx.arena.internPrimitive("i32");
    const leftAlias = resolveTypeAlias(leftSymbol, ctx, state, [intType]);
    const rightAlias = resolveTypeAlias(rightSymbol, ctx, state, [intType]);
    expect(ctx.typeAliases.getCachedInstance(`${leftSymbol}<${intType}>`)).toBe(
      leftAlias
    );
    expect(ctx.typeAliases.getCachedInstance(`${rightSymbol}<${intType}>`)).toBe(
      rightAlias
    );

    const rightDesc = ctx.arena.get(rightAlias);
    expect(rightDesc.kind).toBe("union");
    if (rightDesc.kind === "union") {
      const hasBoxedLeft = rightDesc.members.some((member) => {
        const memberDesc = ctx.arena.get(member);
        if (memberDesc.kind === "intersection" && typeof memberDesc.nominal === "number") {
          const nominalDesc = ctx.arena.get(memberDesc.nominal);
          return (
            nominalDesc.kind === "nominal-object" &&
            nominalDesc.owner.symbol === boxSymbol
          );
        }
        if (memberDesc.kind === "nominal-object") {
          return memberDesc.owner.symbol === boxSymbol;
        }
        return false;
      });
      expect(hasBoxedLeft).toBe(true);
    }
  });

  it("enforces object generic constraints before caching instantiations", () => {
    const { ctx, state, symbolTable } = createContext();
    const valueConstraint = ctx.arena.internStructuralObject({
      fields: [{ name: "value", type: ctx.primitives.bool }],
    });
    const { boxSymbol } = primeBoxTemplate(ctx, symbolTable, valueConstraint);

    expect(() => ensureObjectType(boxSymbol, ctx, state, [ctx.primitives.bool])).toThrow(
      /constraint/
    );

    const payload = ctx.arena.internStructuralObject({
      fields: [{ name: "value", type: ctx.primitives.bool }],
    });
    const info = ensureObjectType(boxSymbol, ctx, state, [payload]);
    expect(info?.type).toBeDefined();
  });

  it("rejects alias instantiation when constraints fail", () => {
    const { ctx, state, symbolTable } = createContext();
    const constraint: HirTypeExpr = {
      typeKind: "object",
      fields: [
        {
          name: "value",
          type: {
            typeKind: "named",
            path: ["i32"],
            ast: 0,
            span: DUMMY_SPAN,
          },
          span: DUMMY_SPAN,
        },
      ],
      ast: 0,
      span: DUMMY_SPAN,
    };
    const { aliasSymbol } = primeAliasTemplate(ctx, symbolTable, {
      constraint,
    });

    expect(() => resolveTypeAlias(aliasSymbol, ctx, state, [ctx.primitives.bool])).toThrow(
      /constraint/
    );

    const i32 =
      ctx.primitives.cache.get("i32") ?? ctx.arena.internPrimitive("i32");
    const valid = ctx.arena.internStructuralObject({
      fields: [{ name: "value", type: i32 }],
    });
    const resolved = resolveTypeAlias(aliasSymbol, ctx, state, [valid]);
    expect(resolved).toBe(valid);
  });

  it("tracks declaring params on generic fields and blocks unsubstituted access", () => {
    const { ctx, state, symbolTable } = createContext();
    const { boxSymbol } = primeBoxTemplate(ctx, symbolTable);

    const template = getObjectTemplate(boxSymbol, ctx, state);
    expect(template?.fields[0]?.declaringParams).toEqual(
      template ? [template.params[0]!.typeParam] : []
    );

    expect(() => getStructuralFields(template?.structural ?? -1, ctx, state)).toThrow(
      /substitutions|type argument/i
    );

    const instantiated = ensureObjectType(boxSymbol, ctx, state, [ctx.primitives.bool]);
    expect(instantiated?.fields[0]?.type).toBe(ctx.primitives.bool);
    const structuralFields = getStructuralFields(
      instantiated?.structural ?? -1,
      ctx,
      state
    );
    expect(
      structuralFields?.find((field) => field.name === "value")?.type
    ).toBe(ctx.primitives.bool);
  });

  it("prevents payload drift for fields annotated with declaring type params", () => {
    const { ctx, state, symbolTable } = createContext();
    const { someSymbol } = primeSomeTemplate(ctx, symbolTable);
    const { mapSymbol, valueParam: mapValueParam } = primeBucketMapTemplate(
      ctx,
      symbolTable,
      someSymbol
    );

    const mapInfo = ensureObjectType(mapSymbol, ctx, state, [
      ctx.primitives.bool,
      ctx.primitives.unknown,
    ]);
    const payloadField = mapInfo?.fields.find(
      (field) => field.name === "payload"
    );
    expect(payloadField?.declaringParams).toEqual([mapValueParam]);

    const concrete = ensureObjectType(mapSymbol, ctx, state, [
      ctx.primitives.bool,
      ctx.primitives.bool,
    ]);
    const concretePayload = concrete?.fields.find(
      (field) => field.name === "payload"
    );
    expect(concretePayload?.type).toBeDefined();
    if (!concretePayload) {
      return;
    }

    const stringType =
      ctx.primitives.cache.get("string") ?? ctx.arena.internPrimitive("string");
    const mismatchedPayload = ctx.arena.internNominalObject({
      owner: { moduleId: "test", symbol: someSymbol },
      name: "Some",
      typeArgs: [stringType],
    });

    expect(typeSatisfies(mismatchedPayload, concretePayload.type, ctx, state)).toBe(
      false
    );
  });

  it("allows guarded recursive aliases", () => {
    const { ctx, state, symbolTable } = createContext();
    const { boxSymbol } = primeBoxTemplate(ctx, symbolTable);
    const aliasSymbol = symbolTable.declare({
      name: "Guarded",
      kind: "type",
      declaredAt: 0,
    });
    const aliasRef: HirTypeExpr = {
      typeKind: "named",
      path: ["Guarded"],
      symbol: aliasSymbol,
      ast: 0,
      span: DUMMY_SPAN,
    };
    const boxedRef: HirTypeExpr = {
      typeKind: "named",
      path: ["Box"],
      symbol: boxSymbol,
      typeArguments: [aliasRef],
      ast: 0,
      span: DUMMY_SPAN,
    };
    const target: HirTypeExpr = {
      typeKind: "union",
      members: [
        boxedRef,
        {
          typeKind: "named",
          path: ["bool"],
          ast: 0,
          span: DUMMY_SPAN,
        },
      ],
      ast: 0,
      span: DUMMY_SPAN,
    };

    ctx.typeAliases.registerTemplate({
      symbol: aliasSymbol,
      params: [],
      target,
    });

    const resolved = resolveTypeAlias(aliasSymbol, ctx, state, []);
    expect(resolved).toBeDefined();
    expect(ctx.typeAliases.getCachedInstance(`${aliasSymbol}<>`)).toBe(resolved);
  });

  it("allows guarded generic recursion across constructors", () => {
    const { ctx, state, symbolTable } = createContext();
    const { boxSymbol } = primeBoxTemplate(ctx, symbolTable);
    const { noneSymbol } = primeNoneTemplate(ctx, symbolTable);
    const typeParamSymbol = symbolTable.declare({
      name: "T",
      kind: "type",
      declaredAt: 0,
    });
    const listSymbol = symbolTable.declare({
      name: "List",
      kind: "type",
      declaredAt: 0,
    });
    const paramRef: HirTypeExpr = {
      typeKind: "named",
      path: ["T"],
      symbol: typeParamSymbol,
      ast: 0,
      span: DUMMY_SPAN,
    };
    const listRef: HirTypeExpr = {
      typeKind: "named",
      path: ["List"],
      symbol: listSymbol,
      typeArguments: [paramRef],
      ast: 0,
      span: DUMMY_SPAN,
    };
    const boxedList: HirTypeExpr = {
      typeKind: "named",
      path: ["Box"],
      symbol: boxSymbol,
      typeArguments: [listRef],
      ast: 0,
      span: DUMMY_SPAN,
    };
    const noneRef: HirTypeExpr = {
      typeKind: "named",
      path: ["None"],
      symbol: noneSymbol,
      typeArguments: [paramRef],
      ast: 0,
      span: DUMMY_SPAN,
    };
    const target: HirTypeExpr = {
      typeKind: "union",
      members: [boxedList, noneRef],
      ast: 0,
      span: DUMMY_SPAN,
    };

    ctx.typeAliases.registerTemplate({
      symbol: listSymbol,
      params: [{ symbol: typeParamSymbol }],
      target,
    });

    const resolved = resolveTypeAlias(listSymbol, ctx, state, [ctx.primitives.bool]);
    expect(resolved).toBeDefined();
    expect(ctx.typeAliases.getCachedInstance(`${listSymbol}<${ctx.primitives.bool}>`)).toBe(
      resolved
    );
  });

  it("keeps contractiveness checks active across repeated instantiations", () => {
    const { ctx, state, symbolTable } = createContext();
    const aliasSymbol = symbolTable.declare({
      name: "Repeat",
      kind: "type",
      declaredAt: 0,
    });
    const aliasRef: HirTypeExpr = {
      typeKind: "named",
      path: ["Repeat"],
      symbol: aliasSymbol,
      ast: 0,
      span: DUMMY_SPAN,
    };
    ctx.typeAliases.registerTemplate({
      symbol: aliasSymbol,
      params: [],
      target: aliasRef,
    });

    expect(() => resolveTypeAlias(aliasSymbol, ctx, state, [])).toThrow();
    const cacheKey = `${aliasSymbol}<>`;
    expect(ctx.typeAliases.hasInstance(cacheKey)).toBe(false);
    expect(() => resolveTypeAlias(aliasSymbol, ctx, state, [])).toThrow();
    expect(ctx.typeAliases.hasInstance(cacheKey)).toBe(false);
  });

  it("unifies composite types with variance-aware substitutions", () => {
    const { ctx } = createContext();
    const param = ctx.arena.freshTypeParam();
    const paramRef = ctx.arena.internTypeParamRef(param);
    const genericFn = ctx.arena.internFunction({
      parameters: [{ type: paramRef, optional: false }],
      returnType: ctx.arena.internUnion([paramRef, ctx.primitives.void]),
      effectRow: ctx.primitives.defaultEffectRow,
    });
    const concreteFn = ctx.arena.internFunction({
      parameters: [{ type: ctx.primitives.bool, optional: false }],
      returnType: ctx.arena.internUnion([ctx.primitives.bool, ctx.primitives.void]),
      effectRow: ctx.primitives.defaultEffectRow,
    });

    const result = ctx.arena.unify(concreteFn, genericFn, {
      location: 0,
      reason: "function variance",
      variance: "covariant",
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.substitution.get(param)).toBe(ctx.primitives.bool);
  });
});
