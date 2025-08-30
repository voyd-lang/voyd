import { Type, TypeAlias } from "../syntax-objects/types.js";

// Format a type name including applied generic type parameters, when present.
export const formatTypeName = (t?: Type | TypeAlias): string => {
  if (!t) return "unknown";

  // TypeAlias may either be a named alias (e.g., MsgPack) or a placeholder
  // for a resolved generic parameter (e.g., T with .type set). Prefer the
  // resolved target when present; otherwise, show the alias name.
  if (t.isTypeAlias?.()) {
    // Prefer a simple identifier from the alias' type expression when present
    // (e.g., MsgPack), which is safe and avoids recursive expansion.
    const te: any = (t as any).typeExpr;
    if (te?.isIdentifier?.()) return te.toString();
    if (te?.isTypeAlias?.()) return te.name.toString();
    // Fallback to the alias name (e.g., T)
    return t.name.toString();
  }

  if (t.isObjectType?.()) {
    const base = t.name.toString();
    const args = t.appliedTypeArgs ?? [];
    if (!args.length) return base;
    const inner = args
      .map((a) => formatTypeName(a as Type | TypeAlias))
      .join(", ");
    return `${base}<${inner}>`;
  }

  if ((t as any).isTraitType?.()) {
    const trait: any = t as any;
    const base = trait.name.toString();
    const args = trait.appliedTypeArgs ?? [];
    if (!args.length) return base;
    const inner = args
      .map((a: any) => formatTypeName(a as Type | TypeAlias))
      .join(", ");
    return `${base}<${inner}>`;
  }

  if (t.isUnionType?.()) {
    // Flatten unions for helpful display: A | B | C
    const parts = t.types.map((tt) => formatTypeName(tt as Type));
    return parts.join(" | ");
  }

  if (t.isIntersectionType?.()) {
    const l = t.nominalType ?? t.structuralType;
    const r = t.structuralType && t.nominalType ? t.structuralType : undefined;
    return [
      formatTypeName(l as Type),
      r ? formatTypeName(r as Type) : undefined,
    ]
      .filter(Boolean)
      .join(" & ");
  }

  if (t.isFnType?.()) {
    const params = t.parameters
      .map((p) => (p.type ? formatTypeName(p.type) : "unknown"))
      .join(", ");
    const ret = formatTypeName(t.returnType as Type);
    return `fn(${params}) -> ${ret}`;
  }

  // Fallback to simple name
  return (t as any).name?.toString?.() ?? "unknown";
};
