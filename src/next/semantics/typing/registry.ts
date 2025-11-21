import {
  registerPrimitive,
  resolveTypeExpr,
  getSymbolName,
} from "./type-system.js";
import {
  BASE_OBJECT_NAME,
  type FunctionSignature,
  type TypingContext,
} from "./types.js";

export const seedPrimitiveTypes = (ctx: TypingContext): void => {
  ctx.voidType = registerPrimitive(ctx, "voyd", "void", "Voyd");
  ctx.boolType = registerPrimitive(ctx, "bool", "boolean", "Bool");
  ctx.unknownType = registerPrimitive(ctx, "unknown");

  registerPrimitive(ctx, "i32");
  registerPrimitive(ctx, "i64");
  registerPrimitive(ctx, "f32");
  registerPrimitive(ctx, "f64");
  registerPrimitive(ctx, "string", "String");
};

export const seedBaseObjectType = (ctx: TypingContext): void => {
  const symbol = ctx.symbolTable.declare({
    name: BASE_OBJECT_NAME,
    kind: "type",
    declaredAt: ctx.hir.module.ast,
    metadata: { intrinsic: true, entity: "object" },
  });

  const structural = ctx.arena.internStructuralObject({ fields: [] });
  const nominal = ctx.arena.internNominalObject({
    owner: symbol,
    name: BASE_OBJECT_NAME,
    typeArgs: [],
  });
  const type = ctx.arena.internIntersection({ nominal, structural });
  const info = {
    nominal,
    structural,
    type,
    fields: [],
    baseNominal: undefined,
  };
  const template = {
    symbol,
    params: [],
    nominal,
    structural,
    type,
    fields: [],
    baseNominal: undefined,
  };

  ctx.baseObjectSymbol = symbol;
  ctx.baseObjectNominal = nominal;
  ctx.baseObjectStructural = structural;
  ctx.baseObjectType = type;

  ctx.objectTemplates.set(symbol, template);
  ctx.objectInstances.set(`${symbol}<>`, info);
  ctx.objectsByNominal.set(nominal, info);
  if (!ctx.objectsByName.has(BASE_OBJECT_NAME)) {
    ctx.objectsByName.set(BASE_OBJECT_NAME, symbol);
  }
  ctx.valueTypes.set(symbol, type);
};

export const registerTypeAliases = (ctx: TypingContext): void => {
  for (const item of ctx.hir.items.values()) {
    if (item.kind !== "type-alias") continue;
    const decl =
      (typeof item.decl === "number"
        ? ctx.decls.getTypeAliasById(item.decl)
        : ctx.decls.getTypeAlias(item.symbol)) ?? undefined;
    if (
      typeof item.decl === "number" &&
      (!decl || decl.symbol !== item.symbol)
    ) {
      throw new Error(
        `missing or mismatched decl for type alias symbol ${item.symbol}`
      );
    }
    ctx.typeAliasTargets.set(item.symbol, item.target);
    const params =
      item.typeParameters ??
      decl?.typeParameters?.map((param) => ({ symbol: param.symbol })) ??
      [];
    ctx.typeAliasTemplates.set(item.symbol, {
      symbol: item.symbol,
      params,
      target: item.target,
    });
    ctx.typeAliasesByName.set(getSymbolName(item.symbol, ctx), item.symbol);
  }
};

export const registerObjectDecls = (ctx: TypingContext): void => {
  for (const item of ctx.hir.items.values()) {
    if (item.kind !== "object") continue;
    ctx.objectDecls.set(item.symbol, item);
    const name = getSymbolName(item.symbol, ctx);
    if (!ctx.objectsByName.has(name)) {
      ctx.objectsByName.set(name, item.symbol);
    }
  }
};

export const registerFunctionSignatures = (ctx: TypingContext): void => {
  for (const item of ctx.hir.items.values()) {
    if (item.kind !== "function") continue;
    const fnDecl =
      (typeof item.decl === "number"
        ? ctx.decls.getFunctionById(item.decl)
        : ctx.decls.getFunction(item.symbol)) ?? undefined;
    if (
      typeof item.decl === "number" &&
      (!fnDecl || fnDecl.symbol !== item.symbol)
    ) {
      throw new Error(
        `missing or mismatched decl for function symbol ${item.symbol}`
      );
    }

    if (fnDecl && fnDecl.params.length !== item.parameters.length) {
      throw new Error(
        `function parameter count mismatch for symbol ${item.symbol}: decl defines ${fnDecl.params.length}, HIR has ${item.parameters.length}`
      );
    }

    const parameters = item.parameters.map((param, index) => {
      const resolved = resolveTypeExpr(param.type, ctx, ctx.unknownType);
      ctx.valueTypes.set(param.symbol, resolved);
      const declParam =
        (typeof param.decl === "number"
          ? ctx.decls.getParameterById(param.decl)
          : undefined) ?? ctx.decls.getParameter(param.symbol);
      if (
        typeof param.decl === "number" &&
        (!declParam || declParam.symbol !== param.symbol)
      ) {
        throw new Error(
          `missing or mismatched parameter decl for symbol ${
            param.symbol
          } in function ${getSymbolName(item.symbol, ctx)}`
        );
      }
      if (
        fnDecl?.params[index] &&
        fnDecl.params[index]!.symbol !== param.symbol
      ) {
        throw new Error(
          `parameter order mismatch for function ${getSymbolName(
            item.symbol,
            ctx
          )}`
        );
      }
      return { type: resolved, label: declParam?.label ?? param.label };
    });

    const hasExplicitReturn = Boolean(item.returnType);
    const declaredReturn =
      resolveTypeExpr(item.returnType, ctx, ctx.unknownType) ?? ctx.unknownType;

    const functionType = ctx.arena.internFunction({
      parameters: parameters.map(({ type, label }) => ({
        type,
        label,
        optional: false,
      })),
      returnType: declaredReturn,
      effects: ctx.defaultEffectRow,
    });

    ctx.functionSignatures.set(item.symbol, {
      typeId: functionType,
      parameters,
      returnType: declaredReturn,
      hasExplicitReturn,
    });
    ctx.valueTypes.set(item.symbol, functionType);

    const scheme = ctx.arena.newScheme([], functionType);
    ctx.table.setSymbolScheme(item.symbol, scheme);
  }
};
