import type { SymbolId } from "../ids.js";
import type { HirFunction, HirTraitMethod, HirTypeExpr } from "../hir/index.js";
import { getSymbolName } from "./type-system.js";
import type { TypingContext } from "./types.js";
import {
  formatMethodSignature,
  methodSignatureKey,
  methodSignatureShapeKey,
} from "./method-signature-key.js";

type MethodWithSymbol = { symbol: SymbolId };

export type TraitDeclMethod = NonNullable<
  ReturnType<TypingContext["decls"]["getTrait"]>
>["methods"][number];

export type ImplDeclMethod = NonNullable<
  ReturnType<TypingContext["decls"]["getImpl"]>
>["methods"][number];

export type TraitMethodSignatureInfo = {
  method: TraitDeclMethod;
  methodHir?: HirTraitMethod;
  key: string;
  shapeKey: string;
  display: string;
  hasDefaultBody: boolean;
  hasSelfReceiver: boolean;
};

export type ImplMethodSignatureInfo = {
  method: ImplDeclMethod;
  key: string;
  shapeKey: string;
  display: string;
};

export type ImportedTraitMethodSignatureInfo = {
  method: HirTraitMethod;
  key: string;
  display: string;
  hasSelfReceiver: boolean;
};

export const buildTraitMethodSignatureInfos = ({
  traitMethods,
  traitMethodsBySymbol,
  ctx,
  traitTypeSubstitutions,
  selfType,
}: {
  traitMethods: readonly TraitDeclMethod[];
  traitMethodsBySymbol: ReadonlyMap<SymbolId, HirTraitMethod>;
  ctx: TypingContext;
  traitTypeSubstitutions?: Map<SymbolId, HirTypeExpr>;
  selfType?: HirTypeExpr;
}): TraitMethodSignatureInfo[] =>
  traitMethods.map((method) => {
    const methodHir = traitMethodsBySymbol.get(method.symbol);
    const methodName = getSymbolName(method.symbol, ctx);
    const typeParamCount = method.typeParameters?.length ?? 0;
    const params = method.params.map((param, index) => ({
      label: param.label,
      name: param.name,
      typeKey:
        index === 0 && param.name === "self"
          ? undefined
          : typeExprKey(
              methodHir?.parameters[index]?.type,
              traitTypeSubstitutions,
              undefined,
              selfType,
            ),
    }));
    return {
      method,
      methodHir,
      key: methodSignatureKey({ methodName, typeParamCount, params }),
      shapeKey: methodSignatureShapeKey({ methodName, typeParamCount, params }),
      display: formatMethodSignature({ methodName, typeParamCount, params }),
      hasDefaultBody: Boolean(method.defaultBody),
      hasSelfReceiver: method.params[0]?.name === "self",
    };
  });

export const buildImplMethodSignatureInfos = ({
  implMethods,
  implFunctionsBySymbol,
  ctx,
  traitTypeSubstitutions,
  selfType,
}: {
  implMethods: readonly ImplDeclMethod[];
  implFunctionsBySymbol: ReadonlyMap<SymbolId, HirFunction | undefined>;
  ctx: TypingContext;
  traitTypeSubstitutions?: Map<SymbolId, HirTypeExpr>;
  selfType?: HirTypeExpr;
}): ImplMethodSignatureInfo[] =>
  implMethods.map((method) => {
    const methodName = getSymbolName(method.symbol, ctx);
    const typeParamCount = method.typeParameters?.length ?? 0;
    const implFunction = implFunctionsBySymbol.get(method.symbol);
    const params = method.params.map((param, index) => ({
      label: param.label,
      name: param.name,
      typeKey:
        index === 0 && param.name === "self"
          ? undefined
          : typeExprKey(
              implFunction?.parameters[index]?.type,
              traitTypeSubstitutions,
              undefined,
              selfType,
            ),
    }));
    return {
      method,
      key: methodSignatureKey({ methodName, typeParamCount, params }),
      shapeKey: methodSignatureShapeKey({ methodName, typeParamCount, params }),
      display: formatMethodSignature({ methodName, typeParamCount, params }),
    };
  });

export const buildTraitMethodSignatureInfosFromHir = ({
  traitMethods,
  ctx,
  traitTypeSubstitutions,
  selfType,
}: {
  traitMethods: readonly HirTraitMethod[];
  ctx: TypingContext;
  traitTypeSubstitutions?: Map<SymbolId, HirTypeExpr>;
  selfType?: HirTypeExpr;
}): ImportedTraitMethodSignatureInfo[] =>
  traitMethods.map((method) => {
    const methodName = getSymbolName(method.symbol, ctx);
    const typeParamCount = method.typeParameters?.length ?? 0;
    const firstParamSymbol = method.parameters[0]?.symbol;
    const firstParamName =
      typeof firstParamSymbol === "number"
        ? getSymbolName(firstParamSymbol, ctx)
        : undefined;
    const params = method.parameters.map((param, index) => {
      const paramName = getSymbolName(param.symbol, ctx);
      return {
        name: paramName,
        typeKey:
          index === 0 && paramName === "self"
            ? undefined
            : typeExprKey(
                param.type,
                traitTypeSubstitutions,
                undefined,
                selfType,
              ),
      };
    });
    return {
      method,
      key: methodSignatureKey({ methodName, typeParamCount, params }),
      display: formatMethodSignature({ methodName, typeParamCount, params }),
      hasSelfReceiver: firstParamName === "self",
    };
  });

export const assertUniqueMethodSignatures = ({
  traitName,
  methods,
}: {
  traitName: string;
  methods: readonly { key: string; display: string }[];
}): void => {
  const bySignature = groupBySignatureKey(methods);
  bySignature.forEach((matches) => {
    if (matches.length < 2) {
      return;
    }
    const duplicate = matches[0];
    if (!duplicate) {
      return;
    }
    throw new Error(
      `trait ${traitName} declares duplicate overload ${duplicate.display}`,
    );
  });
};

export const buildTraitMethodMapByExactSignature = <
  TTrait extends { method: MethodWithSymbol; key: string; display: string },
  TImpl extends { method: MethodWithSymbol; key: string },
>({
  traitMethods,
  implMethods,
  ambiguousMessage,
}: {
  traitMethods: readonly TTrait[];
  implMethods: readonly TImpl[];
  ambiguousMessage: (method: TTrait) => string;
}): Map<SymbolId, SymbolId> => {
  const implMethodsBySignature = groupBySignatureKey(implMethods);
  const methodMap = new Map<SymbolId, SymbolId>();

  traitMethods.forEach((traitMethod) => {
    const implMatches = implMethodsBySignature.get(traitMethod.key) ?? [];
    if (implMatches.length > 1) {
      throw new Error(ambiguousMessage(traitMethod));
    }
    const implMatch = implMatches[0];
    if (implMatch) {
      methodMap.set(traitMethod.method.symbol, implMatch.method.symbol);
    }
  });
  return methodMap;
};

export const matchTraitMethodsWithShapeFallback = ({
  traitMethods,
  implMethods,
  ambiguousMessage,
}: {
  traitMethods: readonly TraitMethodSignatureInfo[];
  implMethods: readonly ImplMethodSignatureInfo[];
  ambiguousMessage: (method: TraitMethodSignatureInfo) => string;
}): {
  matches: readonly {
    traitMethod: TraitMethodSignatureInfo;
    implMethod: ImplMethodSignatureInfo;
  }[];
  missing: readonly TraitMethodSignatureInfo[];
} => {
  const implMethodsBySignature = groupBySignatureKey(implMethods);
  const implMethodsByShape = groupBySignatureShape(implMethods);
  const consumedImplMethodSymbols = new Set<SymbolId>();
  const unresolvedTraitMethods: TraitMethodSignatureInfo[] = [];
  const matches: { traitMethod: TraitMethodSignatureInfo; implMethod: ImplMethodSignatureInfo }[] = [];

  traitMethods.forEach((traitMethod) => {
    const exactMatches = implMethodsBySignature.get(traitMethod.key) ?? [];
    if (exactMatches.length > 1) {
      throw new Error(ambiguousMessage(traitMethod));
    }
    const matchedImpl = exactMatches[0];
    if (matchedImpl) {
      matches.push({ traitMethod, implMethod: matchedImpl });
      consumedImplMethodSymbols.add(matchedImpl.method.symbol);
      return;
    }
    unresolvedTraitMethods.push(traitMethod);
  });

  const missing: TraitMethodSignatureInfo[] = [];
  unresolvedTraitMethods.forEach((traitMethod) => {
    const shapeMatches = (implMethodsByShape.get(traitMethod.shapeKey) ?? []).filter(
      (methodInfo) => !consumedImplMethodSymbols.has(methodInfo.method.symbol),
    );
    if (shapeMatches.length > 1) {
      throw new Error(ambiguousMessage(traitMethod));
    }
    const shapeMatch = shapeMatches[0];
    if (shapeMatch) {
      matches.push({ traitMethod, implMethod: shapeMatch });
      consumedImplMethodSymbols.add(shapeMatch.method.symbol);
      return;
    }
    missing.push(traitMethod);
  });

  return { matches, missing };
};

const groupBySignatureKey = <T extends { key: string }>(
  methods: readonly T[],
): Map<string, T[]> => {
  const grouped = new Map<string, T[]>();
  methods.forEach((method) => {
    const existing = grouped.get(method.key);
    if (existing) {
      existing.push(method);
      return;
    }
    grouped.set(method.key, [method]);
  });
  return grouped;
};

const groupBySignatureShape = <T extends { shapeKey: string }>(
  methods: readonly T[],
): Map<string, T[]> => {
  const grouped = new Map<string, T[]>();
  methods.forEach((method) => {
    const existing = grouped.get(method.shapeKey);
    if (existing) {
      existing.push(method);
      return;
    }
    grouped.set(method.shapeKey, [method]);
  });
  return grouped;
};

export const typeExprKey = (
  expr: HirTypeExpr | undefined,
  substitutions?: Map<SymbolId, HirTypeExpr>,
  visiting?: Set<SymbolId>,
  selfType?: HirTypeExpr,
): string | undefined => {
  if (!expr) return undefined;

  switch (expr.typeKind) {
    case "named": {
      const symbol = expr.symbol;
      const substitution =
        typeof symbol === "number" ? substitutions?.get(symbol) : undefined;
      if (substitution) {
        const nextVisiting = new Set(visiting ?? []);
        if (typeof symbol === "number" && nextVisiting.has(symbol)) {
          return undefined;
        }
        if (typeof symbol === "number") {
          nextVisiting.add(symbol);
        }
        return typeExprKey(substitution, substitutions, nextVisiting, selfType);
      }
      const args = expr.typeArguments?.map((arg) =>
        typeExprKey(arg, substitutions, visiting, selfType),
      );
      const renderedArgs =
        args && args.length > 0
          ? `<${args.map((arg) => arg ?? "_").join(",")}>`
          : "";
      return `${expr.path.join("::")}${renderedArgs}`;
    }
    case "object":
      return "object";
    case "tuple":
      return `(${expr.elements
        .map(
          (entry) =>
            typeExprKey(entry, substitutions, visiting, selfType) ?? "_",
        )
        .join(",")})`;
    case "union":
      return expr.members
        .map(
          (entry) =>
            typeExprKey(entry, substitutions, visiting, selfType) ?? "_",
        )
        .join("|");
    case "intersection":
      return expr.members
        .map(
          (entry) =>
            typeExprKey(entry, substitutions, visiting, selfType) ?? "_",
        )
        .join("&");
    case "function": {
      const typeParamCount = expr.typeParameters?.length ?? 0;
      const params = expr.parameters
        .map((param) => {
          const resolved =
            typeExprKey(param.type, substitutions, visiting, selfType) ?? "_";
          return param.optional ? `${resolved}?` : resolved;
        })
        .join(",");
      const returnKey =
        typeExprKey(expr.returnType, substitutions, visiting, selfType) ?? "void";
      const typeParamPart = typeParamCount > 0 ? `<${typeParamCount}>` : "";
      return `fn${typeParamPart}(${params})->${returnKey}`;
    }
    case "self":
      if (!selfType || selfType.typeKind === "self") return "Self";
      return typeExprKey(selfType, substitutions, visiting, selfType);
    default:
      return undefined;
  }
};
