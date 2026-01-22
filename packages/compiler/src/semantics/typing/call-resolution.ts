export const cloneNestedMap = <K, NK, V>(
  source: ReadonlyMap<K, ReadonlyMap<NK, V>>
): Map<K, Map<NK, V>> =>
  new Map(
    Array.from(source, ([key, inner]) => [key, new Map(inner)] as const)
  );
