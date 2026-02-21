import {
  type Expr,
  formCallsInternal,
  isForm,
  isIdentifierAtom,
  isInternalIdentifierAtom,
} from "../parser/index.js";

export type EnumNamespaceMember = {
  name: string;
  typeArguments?: readonly Expr[];
};

export const importedSymbolTargetFromMetadata = (
  source?: Record<string, unknown>,
): { moduleId: string; symbol: number } | undefined => {
  const meta = source as
    | { import?: { moduleId?: unknown; symbol?: unknown } | undefined }
    | undefined;
  const moduleId = meta?.import?.moduleId;
  const symbol = meta?.import?.symbol;
  return typeof moduleId === "string" && typeof symbol === "number"
    ? { moduleId, symbol }
    : undefined;
};

export const enumNamespaceMetadataFromAliasTarget = ({
  target,
  typeParameterNames,
}: {
  target: Expr | undefined;
  typeParameterNames: readonly string[];
}): {
  enumNamespaceMembers: readonly EnumNamespaceMember[];
  enumNamespaceTypeParameterNames: readonly string[];
} | undefined => {
  const members = collectUnionNominalMembers(target);
  if (!members || members.length === 0) {
    return undefined;
  }
  return {
    enumNamespaceMembers: dedupeEnumNamespaceMembers(members),
    enumNamespaceTypeParameterNames: [...typeParameterNames],
  };
};

export const enumNamespaceMemberTypeArgumentsFromMetadata = ({
  source,
  memberName,
}: {
  source?: Record<string, unknown>;
  memberName: string;
}):
  | {
      typeArguments: readonly Expr[];
      typeParameterNames: readonly string[];
    }
  | undefined => {
  const meta = source as
    | {
        enumNamespaceMembers?: unknown;
        enumNamespaceTypeParameterNames?: unknown;
      }
    | undefined;
  const members = enumNamespaceMembersFromUnknown(meta?.enumNamespaceMembers);
  const member = members?.find((entry) => entry.name === memberName);
  if (!member) {
    return undefined;
  }
  return {
    typeArguments: member.typeArguments ?? [],
    typeParameterNames:
      enumNamespaceTypeParameterNamesFromUnknown(
        meta?.enumNamespaceTypeParameterNames,
      ) ?? [],
  };
};

export const lowerEnumNamespaceMemberTypeArgumentsFromMetadata = <TypeExpr>({
  source,
  memberName,
  namespaceTypeArguments,
  lowerTypeArgument,
  substituteTypeArgument,
}: {
  source?: Record<string, unknown>;
  memberName: string;
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
  const metadata = enumNamespaceMemberTypeArgumentsFromMetadata({
    source,
    memberName,
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

export const enumVariantTypeNamesFromAliasTarget = (
  target: Expr | undefined,
): string[] | undefined => {
  const collected = collectUnionNominalMembers(target);
  if (!collected || collected.length === 0) {
    return undefined;
  }
  return dedupeEnumNamespaceMembers(collected).map((entry) => entry.name);
};

const collectUnionNominalMembers = (
  expr: Expr | undefined,
): EnumNamespaceMember[] | undefined => {
  if (!expr) {
    return undefined;
  }

  if (isForm(expr) && expr.calls("|") && expr.length === 3) {
    const left = collectUnionNominalMembers(expr.at(1));
    const right = collectUnionNominalMembers(expr.at(2));
    if (!left || !right) {
      return undefined;
    }
    return [...left, ...right];
  }

  const nominal = extractNominalTypeMember(expr);
  return nominal ? [nominal] : undefined;
};

const extractNominalTypeMember = (
  expr: Expr | undefined,
): EnumNamespaceMember | undefined => {
  if (!expr) {
    return undefined;
  }

  if (isIdentifierAtom(expr) || isInternalIdentifierAtom(expr)) {
    return { name: expr.value };
  }

  if (!isForm(expr)) {
    return undefined;
  }

  if (formCallsInternal(expr, "generics")) {
    const target = extractNominalTypeMember(expr.at(1));
    if (!target) {
      return undefined;
    }
    const typeArguments = expr.rest.slice(1);
    return typeArguments.length > 0
      ? { ...target, typeArguments }
      : target;
  }

  if (expr.length === 2) {
    const head = expr.at(0);
    const second = expr.at(1);
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

const dedupeEnumNamespaceMembers = (
  members: readonly EnumNamespaceMember[],
): EnumNamespaceMember[] => {
  const byName = new Map<string, EnumNamespaceMember>();
  members.forEach((entry) => {
    if (!byName.has(entry.name)) {
      byName.set(entry.name, entry);
    }
  });
  return Array.from(byName.values());
};

const enumNamespaceMembersFromUnknown = (
  input: unknown,
): EnumNamespaceMember[] | undefined => {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const members = input.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const candidate = entry as { name?: unknown; typeArguments?: unknown };
    if (typeof candidate.name !== "string") {
      return [];
    }
    const typeArguments = Array.isArray(candidate.typeArguments)
      ? (candidate.typeArguments as Expr[])
      : undefined;
    return [{ name: candidate.name, typeArguments }];
  });
  return members.length > 0 ? dedupeEnumNamespaceMembers(members) : undefined;
};

const enumNamespaceTypeParameterNamesFromUnknown = (
  input: unknown,
): string[] | undefined => {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const names = input.filter((entry): entry is string => typeof entry === "string");
  return names.length > 0 ? names : undefined;
};
