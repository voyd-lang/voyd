import { Type } from "../../../syntax-objects/types.js";
import { CanonicalTypeTable } from "../canonical-type-table.js";

const CANON_DEBUG = Boolean(process.env.CANON_DEBUG);

const formatTypeId = (type: Type | undefined): string => {
  if (!type) return "<unknown>";
  if ((type as any).id) return (type as any).id as string;
  if ((type as any).name?.toString) {
    return (type as any).name.toString();
  }
  return type.constructor?.name ?? "<anonymous type>";
};

export const assertCanonicalTypeRef = (
  table: CanonicalTypeTable,
  original?: Type,
  candidate?: Type,
  context?: string
): void => {
  if (!CANON_DEBUG) return;
  if (!original) return;

  const expected = table.canonicalize(original);
  if (!expected) return;

  const resolved = candidate ?? expected;
  const resolvedCanonical = table.getCanonical(resolved);
  if (resolvedCanonical && resolvedCanonical !== resolved) {
    throw new Error(
      `[CANON_DEBUG] canonicalTypeRef returned non-canonical instance${context ? ` (${context})` : ""}: expected ${formatTypeId(resolvedCanonical)} but received ${formatTypeId(resolved)}`
    );
  }

  if (expected !== resolved) {
    const expectedCanonical = table.getCanonical(expected);
    throw new Error(
      `[CANON_DEBUG] canonicalTypeRef mismatch${context ? ` (${context})` : ""}: expected ${formatTypeId(expectedCanonical)} but received ${formatTypeId(resolved)}`
    );
  }
};
