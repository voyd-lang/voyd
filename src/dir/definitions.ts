
export interface IRNode {
    kind: string;
}

export interface IRTypeBase {
    kind: string;
}

export interface IRValueType extends IRTypeBase {
    kind: "value";
    binaryenType: number;
    mutable: boolean;
}

export interface IRMultiValueType extends IRTypeBase {
    kind: "multi-value";
    binaryenType: number[];
    mutable: boolean;
}

export interface IRFunctionType extends IRTypeBase {
    kind: "function";
    parameters: number[];
    locals: number[];
    returnType: IRValueType | IRMultiValueType; // More possible later.
    mutable: boolean;
}

export type IRType =
    IRValueType |
    IRMultiValueType |
    IRFunctionType;

export interface IRNamespace {
    id: string;
    values: string[];
    inherits?: IRNamespace;
}

export interface IRVariableDeclaration extends IRNode {
    kind: "variable-declaration";
    identifierID: string;
    identifierLabel: string;
    flags: string[];
    type: IRType;
    initializer?: IRInstruction;
}

export interface IRMethodDeclaration extends IRNode {
    kind: "method-declaration";
    id: string;
    label: string;
    parameters: IRParameterDeclaration[];
    returnType: IRType;
    flags: string[];
    body: IRInstruction[];
}

export interface IREnumDeclaration extends IRNode {
    kind: "enum-declaration";
    id: string;
    label: string;
    flags: string[];
    variants: IREnumVariant[];
}

export interface IREnumVariant {
    kind: "enum-variant";
    id: string;
    label: string;
    parentEnum: string;
    flags: string[];
    associatedType?: IRType;
}

export interface IRStructDeclaration extends IRNode {
    kind: "struct-declaration";
    id: string;
    label: string;
    fields: { [id: string]: IRType };
    namespaceID: string;
    flags: string[];
}

export interface IRForInStatement extends IRNode {
    kind: "for-in-statement";
    expression: IRNode;
    body: IRInstruction[];
}

export interface IRWhileStatement extends IRNode {
    kind: "while-statement";
    condition: IRInstruction;
    body: IRInstruction[];
}

export interface IRBreakStatement extends IRNode {
    kind: "break-statement";
}

export interface IRContinueStatement extends IRNode {
    kind: "continue-statement";
}

export interface IRIfExpression extends IRNode {
    kind: "if-expression";
    condition: IRInstruction;
    body: IRInstruction[];
    elseBody?: IRInstruction[];
    elseIfBodies?: { expression: IRNode, body: IRInstruction[] }[];
}

export interface IRMatchExpression extends IRNode {
    kind: "match-expression";
    value: IRInstruction;
    valueType: IRType;
    returnType: IRType;
    cases: IRMatchCase[];
    flags: string[];
}

export interface IRMatchCase extends IRNode {
    kind: "match-case",
    case: IRInstruction;
    expression: IRInstruction;
}

export interface IRFunctionStatement extends IRNode {
    kind: "function-declaration";
    id: string;
    parameters: IRParameterDeclaration[];
    returnType: IRType;
    body: IRInstruction[];
}

export interface IRCallExpression extends IRNode {
    kind: "call-expression";
    calleeID: string;
    calleeLabel: string;
    arguments: IRInstruction[];
    returnType: IRType;
}

export interface IRReturnStatement extends IRNode {
    kind: "return-statement";
    expression: IRInstruction;
}

export interface IRParameterDeclaration extends IRNode {
    kind: "parameter-declaration";
    label: string;
    flags: string[];
    type: IRType;
    initializer?: IRInstruction;
}

export interface IRIntLiteral extends IRNode {
    kind: "int-literal";
    value: string;
}

export interface IRFloatLiteral extends IRNode {
    kind: "float-literal";
    value: string;
}

export interface IRStringLiteral extends IRNode {
    kind: "string-literal";
    value: string;
}

export interface IRBoolLiteral extends IRNode {
    kind: "bool-literal";
    value: boolean;
}

export interface IRIdentifier extends IRNode {
    kind: "identifier";
    label: string;
    type: IRType;
}

export interface IRAssignment extends IRNode {
    kind: "assignment";
    identifierID: string;
    identifierLabel: string;
    expression: IRInstruction;
}

export type IRInstruction =
    IRVariableDeclaration |
    IRMethodDeclaration |
    IRStructDeclaration |
    IRForInStatement |
    IRWhileStatement |
    IRIfExpression |
    IRFunctionStatement |
    IRCallExpression |
    IRParameterDeclaration |
    IRType |
    IRContinueStatement |
    IRBreakStatement |
    IRReturnStatement |
    IRIntLiteral |
    IRFloatLiteral |
    IRStringLiteral |
    IRBoolLiteral |
    IRIdentifier |
    IRAssignment |
    IREnumDeclaration |
    IREnumVariant |
    IRMatchCase |
    IRMatchExpression;
