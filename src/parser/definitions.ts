
export interface DreamNode {
    kind: string;
}

export interface VariableDeclaration extends DreamNode {
    kind: "variable-declaration"
    text: string;
    identifier: string;
    flags: string[];
    type: TypeArgument;
    initializer: DreamNode;
}

export interface MethodDeclaration extends DreamNode {
    kind: "method-declaration";
    identifier: string;
    parameters: ParameterDeclaration[];
    typeParameters: TypeParameterDeclaration[];
    returnType: TypeArgument;
    flags: string[];
    body: DreamNode;
}

export interface StructDeclaration extends DreamNode {
    kind: "struct-declaration";
    identifier: string;
    typeParameters: TypeParameterDeclaration[];
    variables: VariableDeclaration[];
    methods: MethodDeclaration[];
    initializers: MethodDeclaration[];
    flags: string[];
}

export interface ForInStatement extends DreamNode {
    kind: "for-in-statement";
    expression: DreamNode;
    body: DreamNode[];
}

export interface WhileStatement extends DreamNode {
    kind: "while-statement";
    expression: DreamNode;
    body: DreamNode[];
}

export interface IfExpression extends DreamNode {
    kind: "if-expression";
    expression: DreamNode;
    ifBody: DreamNode[];
    elseBody: DreamNode[];
    elseIfs: { expression: DreamNode, body: DreamNode[] }[];
}

export interface FunctionStatement extends DreamNode {
    kind: "function-declaration";
    identifier: string;
    parameters: ParameterDeclaration[];
    returnType: string;
    body: DreamNode;
}

export interface MethodOrFunctionCall extends DreamNode {
    kind: "method-or-function-call";
    identifier: string;
    arguments: DreamNode[];
}

export interface TypeParameterDeclaration extends DreamNode {
    kind: "type-parameter-declaration";
    identifier: string;
    constraints: string[];
}

export interface ParameterDeclaration extends DreamNode {
    kind: "parameter-declaration";
    identifier: string;
    flags: string[];
    type: TypeArgument;
}

export interface TypeArgument extends DreamNode {
    kind: "type-argument";
    identifier: string;
    flags: string[];
}
