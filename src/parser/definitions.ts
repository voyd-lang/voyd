
export interface ASTNode {
    kind: string;
}

export interface VariableDeclaration extends ASTNode {
    kind: "variable-declaration"
    label: string;
    flags: string[];
    type?: TypeArgument;
    initializer?: Instruction;
}

export interface FunctionDeclaration extends ASTNode {
    kind: "function-declaration";
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
    methods: FunctionDeclaration[];
    flags: string[];
}

export interface ImplDeclaration extends ASTNode {
    kind: "impl-declaration";
    target: string;
    trait?: string;
    functions: FunctionDeclaration[];
    flags: string[];
}

export interface TypeDeclaration extends ASTNode {
    kind: "type-declaration";
    label: string;
    flags: string[];
    type: TypeArgument;
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

export interface BlockExpression extends ASTNode {
    kind: "block-expression";
    flags: string[];
    body: Instruction[];
}

export interface IfExpression extends ASTNode {
    kind: "if-expression";
    condition: Instruction;
    body: Instruction[];
    elseBody?: Instruction[];
    elifBodies: { condition: ASTNode, body: Instruction[] }[];
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

export interface ClosureExpression extends ASTNode {
    kind: "closure-expression";
    parameters: ParameterDeclaration[];
    returnType: string;
    body: Instruction[];
}

export interface PropertyAccessExpression extends ASTNode {
    kind: "property-access-expression";
    arguments: (PropertyAccessExpression | Identifier)[];
}

export interface CallExpression extends ASTNode {
    kind: "call-expression";
    callee: PropertyAccessExpression | Identifier;
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
    assignee: PropertyAccessExpression | Identifier;
    expression: Instruction;
}

export type Instruction =
    VariableDeclaration |
    FunctionDeclaration |
    StructDeclaration |
    ForInStatement |
    WhileStatement |
    IfExpression |
    ClosureExpression |
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
    BinaryExpression |
    TypeDeclaration |
    BlockExpression |
    PropertyAccessExpression |
    ImplDeclaration;

export type AST = Instruction[];
