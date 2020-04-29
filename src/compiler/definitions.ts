
export interface LocalValue {
    kind: "local";
    identifier: string;
    type: number;
    mutable: boolean;
    index: number;
    flags: string[];
}

export interface GlobalValue {
    kind: "global";
    identifier: string;
    type: number;
    mutable: boolean;
    flags: string[];
}

export interface MethodValue {
    kind: "method";
    identifier: string;
    /** Parameters representing a generic type. */
    typeParameters: number[];
    parameterTypes: number[];
    returnType: string;
    flags: string[];
}

export type Value = LocalValue | MethodValue | GlobalValue;
