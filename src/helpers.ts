
export function isInTuple<T>(item: any, tuple: readonly T[]): item is T {
    return tuple.includes(item);
}
