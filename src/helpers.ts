
export function isInTuple<T>(item: any, tuple: readonly T[]): item is T {
    return tuple.includes(item);
}

// https://stackoverflow.com/a/57103940/2483955
export type DistributiveOmit<T, K extends keyof any> = T extends any
    ? Omit<T, K>
    : never;
