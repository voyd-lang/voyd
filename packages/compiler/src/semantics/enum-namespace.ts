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
  typeParameterCount,
}: {
  target: Expr | undefined;
  typeParameterCount: number;
}): {
  enumNamespaceMembers: readonly EnumNamespaceMember[];
  enumNamespaceTypeParameterCount: number;
} | undefined => {
  const members = collectUnionNominalMembers(target);
  if (!members || members.length === 0) {
    return undefined;
  }
  return {
    enumNamespaceMembers: dedupeEnumNamespaceMembers(members),
    enumNamespaceTypeParameterCount: typeParameterCount,
  };
};

export const enumNamespaceMemberTypeArgumentsFromMetadata = ({
  source,
  memberName,
}: {
  source?: Record<string, unknown>;
  memberName: string;
}): readonly Expr[] | undefined => {
  const meta = source as
    | {
        enumNamespaceMembers?: unknown;
        enumNamespaceTypeParameterCount?: unknown;
      }
    | undefined;
  if (typeof meta?.enumNamespaceTypeParameterCount === "number" && meta.enumNamespaceTypeParameterCount > 0) {
    return undefined;
  }
  const members = enumNamespaceMembersFromUnknown(meta?.enumNamespaceMembers);
  const member = members?.find((entry) => entry.name === memberName);
  const typeArguments = member?.typeArguments;
  return typeArguments && typeArguments.length > 0 ? typeArguments : undefined;
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
