import { Type, TypeAlias } from "../syntax-objects/types.js";

// Format a type name including applied generic type parameters, when present.
export const formatTypeName = (
  t?: Type | TypeAlias,
  seen: Set<Type | TypeAlias> = new Set()
): string => {
  if (!t) return "unknown";
  if (seen.has(t)) return t.name?.toString?.() ?? "unknown";
  seen.add(t);

  // TypeAlias may either be a named alias (e.g., MsgPack) or a placeholder
  // for a resolved generic parameter (e.g., T with .type set). Prefer the
  // resolved target when present; otherwise, show the alias name.
  if (t.isTypeAlias?.()) {
    // Prefer a simple identifier from the alias' type expression when present
    // (e.g., MsgPack), which is safe and avoids recursive expansion.
    const te: any = t.typeExpr;
    if (te?.isIdentifier?.()) return te.toString();
    if (te?.isTypeAlias?.()) return te.name.toString();
    // Fallback to the alias name (e.g., T)
    return t.name.toString();
  }

  if (t.isObjectType?.()) {
    const base = t.name.toString();
    const args = t.resolvedTypeArgs ?? [];
    if (!args.length) return base;
    const inner = args
      .map((a) => formatTypeName(a as Type | TypeAlias, seen))
      .join(", ");
    return `${base}<${inner}>`;
  }

  if (t.isTraitType?.()) {
    const trait = t;
    const base = trait.name.toString();
    const args = trait.resolvedTypeArgs ?? [];
    if (!args.length) return base;
    const inner = args
      .map((a) => formatTypeName(a as Type | TypeAlias, seen))
      .join(", ");
    return `${base}<${inner}>`;
  }

  if (t.isUnionType?.()) {
    // Flatten unions for helpful display: A | B | C
    const parts = t.resolvedMemberTypes.map((tt) =>
      formatTypeName(tt as Type, seen)
    );
    return parts.join(" | ");
  }

  if (t.isIntersectionType?.()) {
    const l = t.nominalType ?? t.structuralType;
    const r = t.structuralType && t.nominalType ? t.structuralType : undefined;
    return [
      formatTypeName(l as Type, seen),
      r ? formatTypeName(r as Type, seen) : undefined,
    ]
      .filter(Boolean)
      .join(" & ");
  }

  if (t.isFnType?.()) {
    const params = t.parameters
      .map((p) => (p.type ? formatTypeName(p.type, seen) : "unknown"))
      .join(", ");
    const ret = formatTypeName(t.returnType as Type, seen);
    return `fn(${params}) -> ${ret}`;
  }

  // Fallback to simple name
  return t.name?.toString?.() ?? "unknown";
};
