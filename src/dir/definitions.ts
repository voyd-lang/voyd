import { Instruction } from "../parser";

export type IR = IRInstruction;

export interface IRModule extends IRNode {
    /** Stores all identifiers in the entire WASM module */
    identifiers: IRIdentifiers;

    /** All of the items the module exports */
    exports: IRNamespace;

    /** List of all the function ids */
    functions: IRFunctions;

    globals: IRGlobals;

    /** All user defined types  */
    types: IRTypes;
}

export interface IRIdentifiers {
    /** Where key is the unique id of the identifier, and value is the key of the type */
    [id: string]: IRIdentifier;
}

export interface IRTypes {
    /** Where key is the unique id of the user defined type, value is the type */
    [id: string]: IRType;
}

export interface IRFunctions {
    [id: string]: IRFunctionDef;
}

export interface IRGlobals {
    [id: string]: IRGlobalDef;
}

///////////////////////////////
///////////////////////////////
///// IRIdentifier
///////////////////////////////
///////////////////////////////

// TODO: Do we remove these? Make functions their own module level category. Do namespace error
// checking on the dir generation side? Make identifiers only point to types?


export type IRIdentifier =
    IRVariableDef |
    IRFunctionDef |
    IRStructDef |
    IRStructFieldDef |
    IREnumDef |
    IREnumVariantDef |
    IRDefinitionBase;


/** A declared definition */
export interface IRDefinitionBase {
    kind: string;
    id: string;
    label: string;
    flags: string[];
}

export interface IRVariableDef extends IRDefinitionBase {
    kind: "value";

    /** Where type is the ID of the type definition */
    type: string;
}

export interface IRTypeDef extends IRDefinitionBase {
    kind: "type";
    namespace: IRNamespace;

    /** Where type is the ID of the type definition */
    type: string;
}

export interface IRFunctionDef extends IRDefinitionBase {
    kind: "function";
    body: Instruction[];
    namespace: IRNamespace;

    /** Where type is the ID of the type definition */
    type: string;
}

export interface IRStructDef extends IRDefinitionBase {
    kind: "struct";
    fields: Set<IRStructFieldDef>;
    namespace: IRNamespace;

    /** Where type is the ID of the type definition */
    type: string;
}

export interface IRStructFieldDef extends IRDefinitionBase {
    kind: "struct-field";
    initializer?: IRInstruction;
}

export interface IREnumDef extends IRDefinitionBase {
    kind: "enum";
    namespace: IRNamespace;
}

export interface IREnumVariantDef extends IRDefinitionBase {
    kind: "enum-variant";
    value: number;
    associatedType?: {
        type: string;
        /** ID of the init function for the type */
        initializer: string;
    };
}

///////////////////////////////
///////////////////////////////
///// Instructions
///////////////////////////////
///////////////////////////////

export type IRInstruction =
    IRWhileStatement |
    IRIfExpression |
    IRCallExpression |
    IRContinueStatement |
    IRBreakStatement |
    IRReturnStatement |
    IRIntLiteral |
    IRFloatLiteral |
    IRStringLiteral |
    IRBoolLiteral |
    IRIdentifierCall |
    IRAssignment |
    IRMatchCase |
    IRMatchExpression;

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
    returnType: string;
    condition: IRInstruction;
    body: IRInstruction[];
    elseBody?: IRInstruction[];
    elseIfBodies?: { expression: IRNode, body: IRInstruction[] }[];
}

export interface IRMatchExpression extends IRNode {
    kind: "match-expression";
    value: IRInstruction;
    valueType: string;
    returnType: string;
    cases: IRMatchCase[];
    flags: string[];
}

export interface IRMatchCase extends IRNode {
    kind: "match-case",
    case: IRInstruction;
    expression: IRInstruction;
}

export interface IRCallExpression extends IRNode {
    kind: "call-expression";
    calleeID: string;
    calleeLabel: string;
    arguments: IRInstruction[];
    /** unique id of the type */
    returnType: string;
}

export interface IRReturnStatement extends IRNode {
    kind: "return-statement";
    expression: IRInstruction;
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
    /** identifier id */
    id: string;
    /** identifier label */
    label: string;
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

/** Todo add support for other wasm types I.E. reftypes, struct, array, etc */
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
    parameters: IRType[];
    locals: IRType[];
    returnType: IRType;
}

export interface IRTypeBase {
    id: string;
    kind: string;
}

/** A set of identifier ids accessible to the namespace owner */
export type IRNamespace = Set<string>;
