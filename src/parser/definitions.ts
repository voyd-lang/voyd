
export interface DreamNode {
    kind: string;
}

export interface VariableDeclaration extends DreamNode {
    kind: "variable-declaration"
    identifier: string;
    flags: string[];
    type?: TypeArgument;
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
    condition: DreamNode;
    body: DreamNode[];
}

export interface BreakStatement extends DreamNode {
    kind: "break-statement";
}

export interface ContinueStatement extends DreamNode {
    kind: "continue-statement";
}

export interface IfExpression extends DreamNode {
    kind: "if-expression";
    condition: DreamNode;
    body: DreamNode[];
    elseBody?: DreamNode[];
    elseIfBodies?: { expression: DreamNode, body: DreamNode[] }[];
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

export interface ReturnStatement extends DreamNode {
    kind: "return-statement";
    expression: DreamNode;
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

export interface I32Literal extends DreamNode {
    kind: "i32-literal";
    value: string;
}

export interface F32Literal extends DreamNode {
    kind: "f32-literal";
    value: string;
}

export interface StringLiteral extends DreamNode {
    kind: "string-literal";
    value: string;
}

export interface BoolLiteral extends DreamNode {
    kind: "bool-literal";
    value: boolean;
}

export interface Block extends DreamNode {
    kind: "block";
    body: Instruction[];
}

export interface Identifier extends DreamNode {
    kind: "identifier";
    value: string;
}

export type Instruction =
    VariableDeclaration |
    MethodDeclaration |
    StructDeclaration |
    ForInStatement |
    WhileStatement |
    IfExpression |
    FunctionStatement |
    MethodOrFunctionCall |
    TypeParameterDeclaration |
    ParameterDeclaration |
    TypeArgument |
    ContinueStatement |
    BreakStatement |
    ReturnStatement |
    I32Literal |
    F32Literal |
    StringLiteral |
    BoolLiteral |
    Block |
    Identifier;
