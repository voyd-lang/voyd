
export interface VariableValue {
    kind: "var";
    identifier: string;
    type: number;
    mutable: boolean;
    isLocal?: boolean;
    localIndex?: number;
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

export type Value = VariableValue | MethodValue;
