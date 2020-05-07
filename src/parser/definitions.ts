
export interface DreamNode {
    kind: string;
}

export interface VariableDeclaration extends DreamNode {
    kind: "variable-declaration"
    identifiers: string[];
    flags: string[];
    type?: TypeArgument;
    initializer?: Instruction;
}

export interface MethodDeclaration extends DreamNode {
    kind: "method-declaration";
    identifier: string;
    parameters: ParameterDeclaration[];
    typeParameters: TypeParameterDeclaration[];
    returnType?: TypeArgument;
    flags: string[];
    body: Instruction[];
}

export interface EnumDeclaration extends DreamNode {
    kind: "enum-declaration";
    identifier: string;
    typeParameters: TypeParameterDeclaration[];
    flags: string[];
    variants: EnumVariant[];
}

export interface EnumVariant {
    kind: "enum-variant";
    identifier: string;
    parentEnum: string;
    flags: string[];
    associatedType?: DreamNode; // TBD
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
    body: Instruction[];
}

export interface WhileStatement extends DreamNode {
    kind: "while-statement";
    condition: Instruction;
    body: Instruction[];
}

export interface BreakStatement extends DreamNode {
    kind: "break-statement";
}

export interface ContinueStatement extends DreamNode {
    kind: "continue-statement";
}

export interface IfExpression extends DreamNode {
    kind: "if-expression";
    condition: Instruction;
    body: Instruction[];
    elseBody?: Instruction[];
    elseIfBodies?: { expression: DreamNode, body: Instruction[] }[];
}

export interface MatchExpression extends DreamNode {
    kind: "match-expression";
    value: Instruction;
    cases: MatchCase[];
    flags: string[];
}

export interface MatchCase extends DreamNode {
    kind: "match-case",
    case: Instruction;
    expression: Instruction;
}

export interface FunctionStatement extends DreamNode {
    kind: "function-declaration";
    identifier: string;
    parameters: ParameterDeclaration[];
    returnType: string;
    body: Instruction[];
}

export interface MethodOrFunctionCall extends DreamNode {
    kind: "method-or-function-call";
    identifier: string;
    arguments: Instruction[];
}

export interface BinaryExpression extends DreamNode {
    kind: "binary-expression";
    identifier: string;
    arguments: [Instruction, Instruction];
}

export interface ReturnStatement extends DreamNode {
    kind: "return-statement";
    expression: Instruction;
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
    type?: TypeArgument;
    initializer?: Instruction;
}

export interface TypeArgument extends DreamNode {
    kind: "type-argument";
    identifier: string;
    flags: string[];
}

export interface IntLiteral extends DreamNode {
    kind: "int-literal";
    value: string;
}

export interface FloatLiteral extends DreamNode {
    kind: "float-literal";
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

export interface Identifier extends DreamNode {
    kind: "identifier";
    value: string;
}

export interface Assignment extends DreamNode {
    kind: "assignment";
    identifier: string;
    expression: Instruction;
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
    IntLiteral |
    FloatLiteral |
    StringLiteral |
    BoolLiteral |
    Identifier |
    Assignment |
    EnumDeclaration |
    EnumVariant |
    MatchCase |
    MatchExpression |
    BinaryExpression;
