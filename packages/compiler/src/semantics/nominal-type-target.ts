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
  path: readonly string[];
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
    return { name: target.value, path: [target.value] };
  }
  if (!isForm(target)) {
    return undefined;
  }
  if (target.calls("::") && target.length === 3) {
    const left = extractNamespacePath(target.at(1));
    const right = extractNominalTypeTarget(target.at(2));
    if (!left || !right) {
      return undefined;
    }
    return {
      name: right.name,
      path: [...left, right.name],
      typeArguments: right.typeArguments,
    };
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
        ? { name: head.value, path: [head.value], typeArguments: second.rest }
        : { name: head.value, path: [head.value] };
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
  moduleMembers,
  ensureModuleMember,
}: {
  target: Expr | undefined;
  scope: ScopeId;
  symbolTable: SymbolTable;
  moduleMembers?: ReadonlyMap<SymbolId, ReadonlyMap<string, ReadonlySet<SymbolId>>>;
  ensureModuleMember?: ({
    moduleSymbol,
    memberName,
  }: {
    moduleSymbol: SymbolId;
    memberName: string;
  }) => void;
}): SymbolId | undefined => {
  const nominal = extractNominalTypeTarget(target);
  if (!nominal) {
    return undefined;
  }
  if (nominal.path.length === 0) {
    return undefined;
  }

  if (nominal.path.length === 1) {
    const symbol = symbolTable.resolve(nominal.name, scope);
    return typeof symbol === "number" ? symbol : undefined;
  }

  const [root, ...rest] = nominal.path;
  const rootSymbol = symbolTable.resolve(root!, scope);
  if (typeof rootSymbol !== "number") {
    return undefined;
  }
  let current = rootSymbol;
  for (let index = 0; index < rest.length; index += 1) {
    const segment = rest[index]!;
    ensureModuleMember?.({ moduleSymbol: current, memberName: segment });
    const members = moduleMembers?.get(current)?.get(segment);
    if (!members || members.size === 0) {
      return undefined;
    }
    const isLast = index === rest.length - 1;
    const selected =
      Array.from(members).find((candidate) => {
        const kind = symbolTable.getSymbol(candidate).kind;
        return isLast
          ? kind === "type" || kind === "trait" || kind === "type-parameter"
          : kind === "module" || kind === "effect";
      }) ?? Array.from(members)[0];
    if (typeof selected !== "number") {
      return undefined;
    }
    current = selected;
  }
  return current;
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

const extractNamespacePath = (expr: Expr | undefined): string[] | undefined => {
  if (!expr) {
    return undefined;
  }
  if (isIdentifierAtom(expr) || isInternalIdentifierAtom(expr)) {
    return [expr.value];
  }
  if (!isForm(expr) || !expr.calls("::") || expr.length !== 3) {
    return undefined;
  }
  const left = extractNamespacePath(expr.at(1));
  const right = extractNamespaceMemberName(expr.at(2));
  if (!left || !right) {
    return undefined;
  }
  return [...left, right];
};

const extractNamespaceMemberName = (expr: Expr | undefined): string | undefined => {
  if (!expr) {
    return undefined;
  }
  if (isIdentifierAtom(expr) || isInternalIdentifierAtom(expr)) {
    return expr.value;
  }
  if (!isForm(expr)) {
    return undefined;
  }

  if (formCallsInternal(expr, "generics")) {
    return extractNamespaceMemberName(expr.at(1));
  }

  if (expr.length === 2) {
    const head = expr.at(0);
    const second = expr.at(1);
    if (
      (isIdentifierAtom(head) || isInternalIdentifierAtom(head)) &&
      isForm(second) &&
      formCallsInternal(second, "generics")
    ) {
      return head.value;
    }
  }

  return undefined;
};
