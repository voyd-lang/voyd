
export interface ASTNode {
    kind: string;
}

export interface VariableDeclaration extends ASTNode {
    kind: "variable-declaration"
    identifierLabel: string;
    flags: string[];
    type?: TypeArgument;
    initializer?: Instruction;
}

export interface MethodDeclaration extends ASTNode {
    kind: "method-declaration";
    label: string;
    parameters: ParameterDeclaration[];
    typeParameters: TypeParameterDeclaration[];
    returnType?: TypeArgument;
    flags: string[];
    body: Instruction[];
}

export interface EnumDeclaration extends ASTNode {
    kind: "enum-declaration";
    label: string;
    typeParameters: TypeParameterDeclaration[];
    flags: string[];
    variants: EnumVariantDeclaration[];
}

export interface EnumVariantDeclaration {
    kind: "enum-variant";
    label: string;
    parentEnum: string;
    flags: string[];
    associatedType?: ASTNode; // TBD
}

export interface StructDeclaration extends ASTNode {
    kind: "struct-declaration";
    label: string;
    typeParameters: TypeParameterDeclaration[];
    variables: VariableDeclaration[];
    methods: MethodDeclaration[];
    initializers: MethodDeclaration[];
    flags: string[];
}

export interface ForInStatement extends ASTNode {
    kind: "for-in-statement";
    expression: ASTNode;
    body: Instruction[];
}

export interface WhileStatement extends ASTNode {
    kind: "while-statement";
    condition: Instruction;
    body: Instruction[];
}

export interface BreakStatement extends ASTNode {
    kind: "break-statement";
}

export interface ContinueStatement extends ASTNode {
    kind: "continue-statement";
}

export interface IfExpression extends ASTNode {
    kind: "if-expression";
    condition: Instruction;
    body: Instruction[];
    elseBody?: Instruction[];
    elseIfBodies?: { expression: ASTNode, body: Instruction[] }[];
}

export interface MatchExpression extends ASTNode {
    kind: "match-expression";
    value: Instruction;
    cases: MatchCase[];
    flags: string[];
}

export interface MatchCase extends ASTNode {
    kind: "match-case",
    case: Instruction;
    expression: Instruction;
}

export interface FunctionStatement extends ASTNode {
    kind: "function-declaration";
    parameters: ParameterDeclaration[];
    returnType: string;
    body: Instruction[];
}

export interface CallExpression extends ASTNode {
    kind: "call-expression";
    calleeLabel: string;
    arguments: Instruction[];
}

export interface BinaryExpression extends ASTNode {
    kind: "binary-expression";
    calleeLabel: string;
    arguments: [Instruction, Instruction];
}

export interface ReturnStatement extends ASTNode {
    kind: "return-statement";
    expression: Instruction;
}

export interface TypeParameterDeclaration extends ASTNode {
    kind: "type-parameter-declaration";
    label: string;
    constraints: string[];
}

export interface ParameterDeclaration extends ASTNode {
    kind: "parameter-declaration";
    label: string;
    flags: string[];
    type?: TypeArgument;
    initializer?: Instruction;
}

export interface TypeArgument extends ASTNode {
    kind: "type-argument";
    label: string;
    flags: string[];
}

export interface IntLiteral extends ASTNode {
    kind: "int-literal";
    value: string;
}

export interface FloatLiteral extends ASTNode {
    kind: "float-literal";
    value: string;
}

export interface StringLiteral extends ASTNode {
    kind: "string-literal";
    value: string;
}

export interface BoolLiteral extends ASTNode {
    kind: "bool-literal";
    value: boolean;
}

export interface Identifier extends ASTNode {
    kind: "identifier";
    label: string;
}

export interface Assignment extends ASTNode {
    kind: "assignment";
    assigneeLabel: string;
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
    CallExpression |
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
    EnumVariantDeclaration |
    MatchCase |
    MatchExpression |
    BinaryExpression;

export type AST = Instruction[];
