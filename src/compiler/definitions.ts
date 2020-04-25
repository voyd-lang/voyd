
export interface VarIdentifier {
    kind: "var";
    identifier: string;
    type: number;
    mutable: boolean;
    isLocal?: boolean;
    localIndex?: number;
    flags: string[];
}

export interface MethodIdentifier {
    kind: "method";
    identifier: string;
    /** Parameters representing a generic type. */
    typeParameters: number[];
    parameterTypes: number[];
    returnType: string;
}

export type Identifier = VarIdentifier | MethodIdentifier;
