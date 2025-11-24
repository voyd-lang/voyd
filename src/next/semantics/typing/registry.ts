import {
  registerPrimitive,
  resolveTypeExpr,
  getSymbolName,
} from "./type-system.js";
import type { SymbolId, TypeId } from "../ids.js";
import {
  BASE_OBJECT_NAME,
  type TypingContext,
  type TypingState,
} from "./types.js";

export const seedPrimitiveTypes = (ctx: TypingContext): void => {
  ctx.primitives.void = registerPrimitive(ctx, "voyd", "void", "Voyd");
  ctx.primitives.bool = registerPrimitive(ctx, "bool", "boolean", "Bool");
  ctx.primitives.unknown = registerPrimitive(ctx, "unknown");

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

  ctx.objects.base = {
    symbol,
    nominal,
    structural,
    type,
  };

  ctx.objects.templates.set(symbol, template);
  ctx.objects.instances.set(`${symbol}<>`, info);
  ctx.objects.byNominal.set(nominal, info);
  if (!ctx.objects.byName.has(BASE_OBJECT_NAME)) {
    ctx.objects.byName.set(BASE_OBJECT_NAME, symbol);
  }
  ctx.valueTypes.set(symbol, type);
};

export const registerTypeAliases = (
  ctx: TypingContext,
  state: TypingState
): void => {
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
    const typeParams = item.typeParameters ?? decl?.typeParameters ?? [];
    const params = typeParams.map((param) => ({
      symbol: param.symbol,
      constraint: "constraint" in param ? param.constraint : undefined,
    }));
    ctx.typeAliases.templates.set(item.symbol, {
      symbol: item.symbol,
      params,
      target: item.target,
    });
    ctx.typeAliases.byName.set(getSymbolName(item.symbol, ctx), item.symbol);
  }
};

export const registerObjectDecls = (ctx: TypingContext): void => {
  for (const item of ctx.hir.items.values()) {
    if (item.kind !== "object") continue;
    ctx.objects.decls.set(item.symbol, item);
    const name = getSymbolName(item.symbol, ctx);
    if (!ctx.objects.byName.has(name)) {
      ctx.objects.byName.set(name, item.symbol);
    }
  }
};

export const registerFunctionSignatures = (
  ctx: TypingContext,
  state: TypingState
): void => {
  for (const item of ctx.hir.items.values()) {
    if (item.kind !== "function") continue;
    ctx.functions.bySymbol.set(item.symbol, item);
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

    const typeParameterDecls =
      item.typeParameters ?? fnDecl?.typeParameters ?? [];
    const paramMap = new Map<SymbolId, TypeId>();
    const typeParams =
      typeParameterDecls.length === 0
        ? undefined
        : typeParameterDecls.map((param) => {
            const typeParam = ctx.arena.freshTypeParam();
            const typeRef = ctx.arena.internTypeParamRef(typeParam);
            paramMap.set(param.symbol, typeRef);
            const constraint =
              "constraint" in param && param.constraint
                ? resolveTypeExpr(
                    param.constraint,
                    ctx,
                    state,
                    ctx.primitives.unknown,
                    paramMap
                  )
                : undefined;
            return { symbol: param.symbol, typeParam, constraint, typeRef };
          });

    if (typeParams && typeParams.length > 0 && !item.returnType) {
      throw new Error(
        `generic function ${getSymbolName(
          item.symbol,
          ctx
        )} must declare a return type`
      );
    }

    const parameters = item.parameters.map((param, index) => {
      const resolved = resolveTypeExpr(
        param.type,
        ctx,
        state,
        ctx.primitives.unknown,
        paramMap
      );
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
      resolveTypeExpr(
        item.returnType,
        ctx,
        state,
        ctx.primitives.unknown,
        paramMap
      ) ?? ctx.primitives.unknown;

    const functionType = ctx.arena.internFunction({
      parameters: parameters.map(({ type, label }) => ({
        type,
        label,
        optional: false,
      })),
      returnType: declaredReturn,
      effects: ctx.primitives.defaultEffectRow,
    });

    const scheme = ctx.arena.newScheme(
      typeParams?.map((param) => param.typeParam) ?? [],
      functionType
    );

    ctx.functions.signatures.set(item.symbol, {
      typeId: functionType,
      parameters,
      returnType: declaredReturn,
      hasExplicitReturn,
      typeParams,
      scheme,
      typeParamMap:
        typeParams && typeParams.length > 0
          ? new Map(
              typeParams.map((param) => [param.symbol, param.typeRef] as const)
            )
          : undefined,
    });
    ctx.valueTypes.set(item.symbol, functionType);

    ctx.table.setSymbolScheme(item.symbol, scheme);
  }
};
