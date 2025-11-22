import { describe, expect, it } from "vitest";
import { SymbolTable } from "../../binder/index.js";
import { createTypingContext } from "../context.js";
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
  });
  seedPrimitiveTypes(ctx);
  seedBaseObjectType(ctx);
  return { ctx, symbolTable };
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
    owner: boxSymbol,
    name: "Box",
    typeArgs: [typeParamRef],
  });
  const type = ctx.arena.internIntersection({ nominal, structural });
  ctx.objectTemplates.set(boxSymbol, {
    symbol: boxSymbol,
    params: [{ symbol: typeParamSymbol, typeParam, constraint }],
    nominal,
    structural,
    type,
    fields,
    baseNominal: undefined,
  });
  ctx.objectsByName.set("Box", boxSymbol);
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
    owner: someSymbol,
    name: "Some",
    typeArgs: [typeParamRef],
  });
  const type = ctx.arena.internIntersection({ nominal, structural });
  ctx.objectTemplates.set(someSymbol, {
    symbol: someSymbol,
    params: [{ symbol: typeParamSymbol, typeParam }],
    nominal,
    structural,
    type,
    fields,
    baseNominal: undefined,
  });
  ctx.objectsByName.set("Some", someSymbol);
  return { someSymbol, valueParam: typeParam };
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
    owner: someSymbol,
    name: "Some",
    typeArgs: [valueRef],
  });
  const fields = [
    { name: "bucketKey", type: keyRef, declaringParams: [keyParam] },
    { name: "payload", type: payload, declaringParams: [valueParam] },
  ];
  const structural = ctx.arena.internStructuralObject({ fields });
  const nominal = ctx.arena.internNominalObject({
    owner: mapSymbol,
    name: "BucketMap",
    typeArgs: [keyRef, valueRef],
  });
  const type = ctx.arena.internIntersection({ nominal, structural });
  ctx.objectTemplates.set(mapSymbol, {
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
  ctx.objectsByName.set("BucketMap", mapSymbol);
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
  ctx.typeAliasTemplates.set(aliasSymbol, {
    symbol: aliasSymbol,
    params: [{ symbol: paramSymbol, constraint: options.constraint }],
    target,
  });
  ctx.typeAliasTargets.set(aliasSymbol, target);
  return { aliasSymbol };
};

describe("instantiation argument handling", () => {
  it("does not cache unknown object instantiations", () => {
    const { ctx, symbolTable } = createContext();
    const { boxSymbol } = primeBoxTemplate(ctx, symbolTable);
    const unknownKey = `${boxSymbol}<${ctx.unknownType}>`;

    const info = ensureObjectType(boxSymbol, ctx, [ctx.unknownType]);
    expect(info).toBeDefined();
    expect(ctx.objectInstances.has(unknownKey)).toBe(false);
    expect(ctx.objectsByNominal.has(info?.nominal ?? -1)).toBe(false);
    expect(ctx.valueTypes.has(boxSymbol)).toBe(false);

    const boolKey = `${boxSymbol}<${ctx.boolType}>`;
    const concrete = ensureObjectType(boxSymbol, ctx, [ctx.boolType]);
    expect(ctx.objectInstances.get(boolKey)).toEqual(concrete);
    expect(ctx.valueTypes.get(boxSymbol)).toBe(concrete?.type);
  });

  it("throws for missing object type arguments in strict mode", () => {
    const { ctx, symbolTable } = createContext();
    const { boxSymbol } = primeBoxTemplate(ctx, symbolTable);
    ctx.typeCheckMode = "strict";
    expect(() => ensureObjectType(boxSymbol, ctx, [])).toThrow(
      /missing 1 type argument/
    );
  });

  it("fails when alias arguments are missing", () => {
    const { ctx, symbolTable } = createContext();
    const { aliasSymbol } = primeAliasTemplate(ctx, symbolTable);

    expect(() => resolveTypeAlias(aliasSymbol, ctx, [])).toThrow(
      /missing 1 type argument/
    );

    ctx.typeCheckMode = "strict";
    expect(() => resolveTypeAlias(aliasSymbol, ctx, [])).toThrow(
      /missing 1 type argument/
    );
    expect(ctx.typeAliasInstances.size).toBe(0);
  });

  it("rejects aliases that resolve directly to themselves", () => {
    const { ctx, symbolTable } = createContext();
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
    ctx.typeAliasTemplates.set(aliasSymbol, {
      symbol: aliasSymbol,
      params: [],
      target,
    });
    ctx.typeAliasTargets.set(aliasSymbol, target);

    expect(() => resolveTypeAlias(aliasSymbol, ctx, [])).toThrow(
      /cannot resolve to itself/
    );
    expect(ctx.typeAliasInstances.size).toBe(0);
    expect(
      ctx.failedTypeAliasInstantiations.has(`${aliasSymbol}<>`)
    ).toBe(true);
  });

  it("resolves recursive aliases through constructors", () => {
    const { ctx, symbolTable } = createContext();
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

    ctx.typeAliasTemplates.set(aliasSymbol, {
      symbol: aliasSymbol,
      params: [],
      target,
    });
    ctx.typeAliasTargets.set(aliasSymbol, target);

    const resolved = resolveTypeAlias(aliasSymbol, ctx, []);
    const desc = ctx.arena.get(resolved);
    expect(desc.kind).toBe("union");
    if (desc.kind !== "union") {
      return;
    }
    const boxedMember = desc.members.find((member) => {
      const memberDesc = ctx.arena.get(member);
      if (memberDesc.kind === "intersection" && typeof memberDesc.nominal === "number") {
        const nominalDesc = ctx.arena.get(memberDesc.nominal);
        return nominalDesc.kind === "nominal-object" && nominalDesc.owner === boxSymbol;
      }
      if (memberDesc.kind === "nominal-object") {
        return memberDesc.owner === boxSymbol;
      }
      return false;
    });
    expect(boxedMember).toBeDefined();
    expect(resolveTypeAlias(aliasSymbol, ctx, [])).toBe(resolved);
  });

  it("resolves mutually recursive aliases", () => {
    const { ctx, symbolTable } = createContext();
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

    ctx.typeAliasTemplates.set(leftSymbol, {
      symbol: leftSymbol,
      params: [],
      target: leftTarget,
    });
    ctx.typeAliasTargets.set(leftSymbol, leftTarget);
    ctx.typeAliasTemplates.set(rightSymbol, {
      symbol: rightSymbol,
      params: [],
      target: rightTarget,
    });
    ctx.typeAliasTargets.set(rightSymbol, rightTarget);

    const leftAlias = resolveTypeAlias(leftSymbol, ctx, []);
    const rightAlias = resolveTypeAlias(rightSymbol, ctx, []);

    expect(ctx.typeAliasInstances.get(`${leftSymbol}<>`)).toBe(leftAlias);
    expect(ctx.typeAliasInstances.get(`${rightSymbol}<>`)).toBe(rightAlias);

    const leftDesc = ctx.arena.get(leftAlias);
    const rightDesc = ctx.arena.get(rightAlias);
    expect(leftDesc.kind).toBe("union");
    expect(rightDesc.kind).toBe("union");
    if (rightDesc.kind === "union") {
      const hasBoxedLeft = rightDesc.members.some((member) => {
        const memberDesc = ctx.arena.get(member);
        if (memberDesc.kind === "intersection" && typeof memberDesc.nominal === "number") {
          const nominalDesc = ctx.arena.get(memberDesc.nominal);
          return nominalDesc.kind === "nominal-object" && nominalDesc.owner === boxSymbol;
        }
        if (memberDesc.kind === "nominal-object") {
          return memberDesc.owner === boxSymbol;
        }
        return false;
      });
      expect(hasBoxedLeft).toBe(true);
    }
  });

  it("supports generic recursive aliases with explicit self arguments", () => {
    const { ctx, symbolTable } = createContext();
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

    ctx.typeAliasTemplates.set(listSymbol, {
      symbol: listSymbol,
      params: [{ symbol: typeParamSymbol }],
      target,
    });
    ctx.typeAliasTargets.set(listSymbol, target);

    const resolved = resolveTypeAlias(listSymbol, ctx, [ctx.boolType]);
    const key = `${listSymbol}<${ctx.boolType}>`;
    expect(ctx.typeAliasInstances.get(key)).toBe(resolved);
    const desc = ctx.arena.get(resolved);
    expect(desc.kind).toBe("union");
  });

  it("resolves mutually recursive generic aliases", () => {
    const { ctx, symbolTable } = createContext();
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

    ctx.typeAliasTemplates.set(leftSymbol, {
      symbol: leftSymbol,
      params: [{ symbol: leftParamSymbol }],
      target: leftTarget,
    });
    ctx.typeAliasTargets.set(leftSymbol, leftTarget);
    ctx.typeAliasTemplates.set(rightSymbol, {
      symbol: rightSymbol,
      params: [{ symbol: rightParamSymbol }],
      target: rightTarget,
    });
    ctx.typeAliasTargets.set(rightSymbol, rightTarget);

    const intType =
      ctx.primitiveCache.get("i32") ?? ctx.arena.internPrimitive("i32");
    const leftAlias = resolveTypeAlias(leftSymbol, ctx, [intType]);
    const rightAlias = resolveTypeAlias(rightSymbol, ctx, [intType]);
    expect(ctx.typeAliasInstances.get(`${leftSymbol}<${intType}>`)).toBe(
      leftAlias
    );
    expect(ctx.typeAliasInstances.get(`${rightSymbol}<${intType}>`)).toBe(
      rightAlias
    );

    const rightDesc = ctx.arena.get(rightAlias);
    expect(rightDesc.kind).toBe("union");
    if (rightDesc.kind === "union") {
      const hasBoxedLeft = rightDesc.members.some((member) => {
        const memberDesc = ctx.arena.get(member);
        if (memberDesc.kind === "intersection" && typeof memberDesc.nominal === "number") {
          const nominalDesc = ctx.arena.get(memberDesc.nominal);
          return nominalDesc.kind === "nominal-object" && nominalDesc.owner === boxSymbol;
        }
        if (memberDesc.kind === "nominal-object") {
          return memberDesc.owner === boxSymbol;
        }
        return false;
      });
      expect(hasBoxedLeft).toBe(true);
    }
  });

  it("enforces object generic constraints before caching instantiations", () => {
    const { ctx, symbolTable } = createContext();
    const valueConstraint = ctx.arena.internStructuralObject({
      fields: [{ name: "value", type: ctx.boolType }],
    });
    const { boxSymbol } = primeBoxTemplate(ctx, symbolTable, valueConstraint);

    expect(() => ensureObjectType(boxSymbol, ctx, [ctx.boolType])).toThrow(
      /constraint/
    );

    const payload = ctx.arena.internStructuralObject({
      fields: [{ name: "value", type: ctx.boolType }],
    });
    const info = ensureObjectType(boxSymbol, ctx, [payload]);
    expect(info?.type).toBeDefined();
  });

  it("rejects alias instantiation when constraints fail", () => {
    const { ctx, symbolTable } = createContext();
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

    expect(() => resolveTypeAlias(aliasSymbol, ctx, [ctx.boolType])).toThrow(
      /constraint/
    );

    const i32 =
      ctx.primitiveCache.get("i32") ?? ctx.arena.internPrimitive("i32");
    const valid = ctx.arena.internStructuralObject({
      fields: [{ name: "value", type: i32 }],
    });
    const resolved = resolveTypeAlias(aliasSymbol, ctx, [valid]);
    expect(resolved).toBe(valid);
  });

  it("tracks declaring params on generic fields and blocks unsubstituted access", () => {
    const { ctx, symbolTable } = createContext();
    const { boxSymbol } = primeBoxTemplate(ctx, symbolTable);

    const template = getObjectTemplate(boxSymbol, ctx);
    expect(template?.fields[0]?.declaringParams).toEqual(
      template ? [template.params[0]!.typeParam] : []
    );

    expect(() => getStructuralFields(template?.structural ?? -1, ctx)).toThrow(
      /substitutions|type argument/i
    );

    const instantiated = ensureObjectType(boxSymbol, ctx, [ctx.boolType]);
    expect(instantiated?.fields[0]?.type).toBe(ctx.boolType);
    const structuralFields = getStructuralFields(
      instantiated?.structural ?? -1,
      ctx
    );
    expect(
      structuralFields?.find((field) => field.name === "value")?.type
    ).toBe(ctx.boolType);
  });

  it("prevents payload drift for fields annotated with declaring type params", () => {
    const { ctx, symbolTable } = createContext();
    const { someSymbol } = primeSomeTemplate(ctx, symbolTable);
    const { mapSymbol, valueParam: mapValueParam } = primeBucketMapTemplate(
      ctx,
      symbolTable,
      someSymbol
    );

    const mapInfo = ensureObjectType(mapSymbol, ctx, [
      ctx.boolType,
      ctx.unknownType,
    ]);
    const payloadField = mapInfo?.fields.find(
      (field) => field.name === "payload"
    );
    expect(payloadField?.declaringParams).toEqual([mapValueParam]);

    const concrete = ensureObjectType(mapSymbol, ctx, [
      ctx.boolType,
      ctx.boolType,
    ]);
    const concretePayload = concrete?.fields.find(
      (field) => field.name === "payload"
    );
    expect(concretePayload?.type).toBeDefined();
    if (!concretePayload) {
      return;
    }

    const stringType =
      ctx.primitiveCache.get("string") ?? ctx.arena.internPrimitive("string");
    const mismatchedPayload = ctx.arena.internNominalObject({
      owner: someSymbol,
      name: "Some",
      typeArgs: [stringType],
    });

    expect(typeSatisfies(mismatchedPayload, concretePayload.type, ctx)).toBe(
      false
    );
  });

  it("unifies composite types with variance-aware substitutions", () => {
    const { ctx } = createContext();
    const param = ctx.arena.freshTypeParam();
    const paramRef = ctx.arena.internTypeParamRef(param);
    const genericFn = ctx.arena.internFunction({
      parameters: [{ type: paramRef, optional: false }],
      returnType: ctx.arena.internUnion([paramRef, ctx.voidType]),
      effects: ctx.defaultEffectRow,
    });
    const concreteFn = ctx.arena.internFunction({
      parameters: [{ type: ctx.boolType, optional: false }],
      returnType: ctx.arena.internUnion([ctx.boolType, ctx.voidType]),
      effects: ctx.defaultEffectRow,
    });

    const result = ctx.arena.unify(concreteFn, genericFn, {
      location: 0,
      reason: "function variance",
      variance: "covariant",
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.substitution.get(param)).toBe(ctx.boolType);
  });
});
