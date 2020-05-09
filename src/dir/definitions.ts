
export type IR = IRInstruction;

export interface IRModule extends IRNode {
    /** Stores all identifiers in the entire WASM module */
    identifiers: IRIdentifiers;
    /** Top level namespace */
    namespace: IRNamespace;

    instructions: IRInstruction[];
}

export interface IRNamespace {
    id: string;
    /** Set of identifier ids accessible to this namespace */
    fields: Set<string>;
}

export interface IRIdentifiers {
    [id: string]: IRDefinition;
}

/**
 * This may need to be fused with IRTypes, there is some redundancy and confusion there
 * Currently my thought is that these should include "Type", "Namespace", and other corresponding
 * information such as label and id. Types don't include that
 * */
export type IRDefinition =
    IRValueDef |
    IRFunctionDef |
    IRStructDef |
    IRStructFieldDef |
    IREnumDef |
    IREnumVariantDef |
    IRDefinitionBase;

export interface IRValueDef extends IRDefinitionBase {
    defKind: "value";
}

export interface IRFunctionDef extends IRDefinitionBase {
    defKind: "function";
    type: IRFunctionType;
    namespace: IRNamespace;
}

export interface IRStructDef extends IRDefinitionBase { // May need to distinguish reference and value type structs (analog is swift class vs struct)
    defKind: "struct";
    type: IRMultiValueType;
    fields: Set<IRStructFieldDef>;
    namespace: IRNamespace;
}

export interface IRStructFieldDef extends IRDefinitionBase {
    defKind: "struct-field";
    type: IRType;
}

export interface IREnumDef extends IRDefinitionBase {
    defKind: "enum";
    variants: Set<IREnumVariantDef>
    namespace: IRNamespace;
}

export interface IREnumVariantDef extends IRDefinitionBase {
    defKind: "enum-variant";
    value: number;
    associatedType?: IRType;
}

/** A declared definition */
export interface IRDefinitionBase extends IRNode {
    kind: "identifier";
    defKind: string;
    id: string;
    label: string;
    type: IRType;
}

///////////////////////////////
///////////////////////////////
///// Instructions
///////////////////////////////
///////////////////////////////

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
    IRIdentifierCall |
    IRAssignment |
    IREnumDeclaration |
    IREnumVariantDeclaration |
    IRMatchCase |
    IRMatchExpression;

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
    variants: IREnumVariantDeclaration[];
}

export interface IREnumVariantDeclaration {
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

/** This instruction should return the value of the identifier, it is not a function call. */
export interface IRIdentifierCall extends IRNode {
    kind: "identifier";
    id: string;
    label: string;
    type: IRType;
}

export interface IRAssignment extends IRNode {
    kind: "assignment";
    identifierID: string;
    identifierLabel: string;
    expression: IRInstruction;
}

export interface IRNode {
    kind: string;
}

///////////////////////////////
///////////////////////////////
///// Types
///////////////////////////////
///////////////////////////////

export type IRType =
    IRValueType |
    IRMultiValueType |
    IRFunctionType;

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

export interface IRTypeBase {
    kind: string;
}
