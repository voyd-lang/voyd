
export interface VarIdentifier {
    kind: "var";
    identifier: string;
    type: string;
    mutable: boolean;
    flags: string[];
}

export interface MethodIdentifier {
    kind: "method";
    identifier: string;
    /** Parameters representing a generic type. */
    typeParameters: string[];
    parameterTypes: string[];
    returnType: string;
}

export type Identifier = VarIdentifier | MethodIdentifier;
