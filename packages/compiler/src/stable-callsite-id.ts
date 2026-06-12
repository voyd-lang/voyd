import { murmurHash3 } from "@voyd-lang/lib/murmur-hash.js";
import type { SourceSpan } from "./semantics/ids.js";

export const stableCallsiteIdFor = (
  span: SourceSpan | undefined,
  salt = "",
): number =>
  murmurHash3(
    `${span?.file ?? "<unknown>"}:${span?.start ?? 0}:${span?.end ?? 0}:${salt}`,
  );
