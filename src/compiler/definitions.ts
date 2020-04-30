
export interface LocalValue {
    kind: "local";
    id: string;
    type: number;
    mutable: boolean;
    index: number;
    nonParameter?: boolean;
    flags: string[];
}

export interface GlobalValue {
    kind: "global";
    id: string;
    type: number;
    mutable: boolean;
    flags: string[];
}

export interface MethodValue {
    kind: "method";
    id: string;
    parameters: number[];
    returnType: number;
    flags: string[];
}

export type Value = LocalValue | MethodValue | GlobalValue;
