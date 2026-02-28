import {
  type Expr,
  formCallsInternal,
  isForm,
  isIdentifierAtom,
  isInternalIdentifierAtom,
} from "../parser/index.js";
import type { SymbolTable } from "./binder/index.js";
import type { ScopeId, SymbolId } from "./ids.js";

export type NominalTypeTarget = {
  name: string;
  typeArguments?: readonly Expr[];
};

export type NominalTypeTargetMetadata = {
  nominalTargetTypeArguments: readonly Expr[];
  nominalTargetTypeParameterNames: readonly string[];
};

export const extractNominalTypeTarget = (
  target: Expr | undefined,
): NominalTypeTarget | undefined => {
  if (!target) {
    return undefined;
  }
  if (isIdentifierAtom(target) || isInternalIdentifierAtom(target)) {
    return { name: target.value };
  }
  if (!isForm(target)) {
    return undefined;
  }
  if (formCallsInternal(target, "generics")) {
    const nominal = extractNominalTypeTarget(target.at(1));
    if (!nominal) {
      return undefined;
    }
    const typeArguments = target.rest.slice(1);
    return typeArguments.length > 0
      ? { ...nominal, typeArguments }
      : nominal;
  }
  if (target.length === 2) {
    const head = target.at(0);
    const second = target.at(1);
    if (
      (isIdentifierAtom(head) || isInternalIdentifierAtom(head)) &&
      isForm(second) &&
      formCallsInternal(second, "generics")
    ) {
      return second.rest.length > 0
        ? { name: head.value, typeArguments: second.rest }
        : { name: head.value };
    }
  }
  return undefined;
};

export const extractNominalTypeName = (
  target: Expr | undefined,
): string | undefined => extractNominalTypeTarget(target)?.name;

export const nominalTypeTargetMetadataFromAliasTarget = ({
  target,
  typeParameterNames,
}: {
  target: Expr | undefined;
  typeParameterNames: readonly string[];
}): NominalTypeTargetMetadata | undefined => {
  const nominal = extractNominalTypeTarget(target);
  if (!nominal?.typeArguments || nominal.typeArguments.length === 0) {
    return undefined;
  }
  return {
    nominalTargetTypeArguments: [...nominal.typeArguments],
    nominalTargetTypeParameterNames: [...typeParameterNames],
  };
};

export const nominalTypeTargetTypeArgumentsFromMetadata = ({
  source,
}: {
  source?: Record<string, unknown>;
}):
  | {
      typeArguments: readonly Expr[];
      typeParameterNames: readonly string[];
    }
  | undefined => {
  const meta = source as
    | {
        nominalTargetTypeArguments?: unknown;
        nominalTargetTypeParameterNames?: unknown;
      }
    | undefined;
  if (!Array.isArray(meta?.nominalTargetTypeArguments)) {
    return undefined;
  }
  const typeArguments = meta.nominalTargetTypeArguments as readonly Expr[];
  const typeParameterNames = Array.isArray(meta?.nominalTargetTypeParameterNames)
    ? meta.nominalTargetTypeParameterNames.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  return {
    typeArguments,
    typeParameterNames,
  };
};

export const lowerNominalTargetTypeArgumentsFromMetadata = <TypeExpr>({
  source,
  namespaceTypeArguments,
  lowerTypeArgument,
  substituteTypeArgument,
}: {
  source?: Record<string, unknown>;
  namespaceTypeArguments?: readonly TypeExpr[];
  lowerTypeArgument: (entry: Expr) => TypeExpr | undefined;
  substituteTypeArgument: ({
    typeArgument,
    substitutionsByName,
  }: {
    typeArgument: TypeExpr;
    substitutionsByName: ReadonlyMap<string, TypeExpr | undefined>;
  }) => TypeExpr;
}): {
  typeArguments?: TypeExpr[];
  consumeNamespaceTypeArguments: boolean;
} => {
  const metadata = nominalTypeTargetTypeArgumentsFromMetadata({
    source,
  });
  if (!metadata) {
    return { consumeNamespaceTypeArguments: false };
  }

  const hasNamespaceTypeArguments = (namespaceTypeArguments?.length ?? 0) > 0;
  if (
    !hasNamespaceTypeArguments &&
    metadata.typeArguments.some((entry) =>
      exprReferencesTypeParameters({
        expr: entry,
        typeParameterNames: metadata.typeParameterNames,
      }),
    )
  ) {
    return { consumeNamespaceTypeArguments: false };
  }

  const substitutionsByName = new Map(
    metadata.typeParameterNames.map((name, index) => [
      name,
      namespaceTypeArguments?.[index],
    ]),
  );
  const lowered = metadata.typeArguments.flatMap((entry) => {
    const typeArgument = lowerTypeArgument(entry);
    if (!typeArgument) {
      return [];
    }
    return [
      substituteTypeArgument({
        typeArgument,
        substitutionsByName,
      }),
    ];
  });

  return {
    typeArguments: lowered.length > 0 ? lowered : undefined,
    consumeNamespaceTypeArguments: true,
  };
};

export const resolveNominalTypeSymbol = ({
  target,
  scope,
  symbolTable,
}: {
  target: Expr | undefined;
  scope: ScopeId;
  symbolTable: SymbolTable;
}): SymbolId | undefined => {
  const name = extractNominalTypeName(target);
  if (!name) {
    return undefined;
  }
  const symbol = symbolTable.resolve(name, scope);
  return typeof symbol === "number" ? symbol : undefined;
};

const exprReferencesTypeParameters = ({
  expr,
  typeParameterNames,
}: {
  expr: Expr;
  typeParameterNames: readonly string[];
}): boolean => {
  if (typeParameterNames.length === 0) {
    return false;
  }
  const names = new Set(typeParameterNames);
  return exprReferencesTypeParametersRecursive(expr, names);
};

const exprReferencesTypeParametersRecursive = (
  expr: Expr | undefined,
  typeParameterNames: ReadonlySet<string>,
): boolean => {
  if (!expr) {
    return false;
  }
  if (isIdentifierAtom(expr) || isInternalIdentifierAtom(expr)) {
    return typeParameterNames.has(expr.value);
  }
  if (!isForm(expr)) {
    return false;
  }
  return expr.toArray().some((entry) =>
    exprReferencesTypeParametersRecursive(entry, typeParameterNames),
  );
};
