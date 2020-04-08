
export function isInTuple<T>(item: any, tuple: ReadonlyArray<T>): item is T {
    return tuple.includes(item);
}
