
export interface IR {
    /** Stores all identifiers in the entire WASM module */
    entities: IREntities;

    /** Key is the label, value is a list of entity ID's where the entity has that label */
    entitiesByLabel: { [label: string]: Set<string> };

    /** Top level namespace */
    namespace: IRNamespace;

    /** All of the items the module exports */
    exports: Set<string>;

    /** List of all the function ids */
    functions: Set<string>;

    /** All user defined types  */
    wasmTypes: WASMTypes;
}

export interface IREntities {
    /** Where key is the unique id of the identifier, and value is the key of the type */
    [id: string]: IREntity;
}

export interface WASMTypes {
    /** Where key is the unique id of the user defined type, value is the type */
    [id: string]: WASMType;
}

export interface IRFunctions {
    [id: string]: string;
}

export interface IRGlobals {
    [id: string]: string;
}

///////////////////////////////
///////////////////////////////
///// IREntities
///////////////////////////////
///////////////////////////////

/** Any item that can be referenced by an identifier */
export type IREntity =
    IRVariableDef |
    IRMethodDef |
    IRStructDef |
    IRStructFieldDef |
    IREnumDef |
    IRTypeDef |
    IREnumVariantDef;


/** A declared definition */
export interface IREntityDefinitionBase {
    kind: string;
    id: string;
    label: string;
    flags: string[];

    /** The entity represents a type */
    isType?: boolean;

    /** Where type is the ID of the type definition */
    wasmType: string;
}

export interface IRVariableDef extends IREntityDefinitionBase {
    kind: "variable";

    /** Entity ID of the struct, enum, or type def that defines this variable */
    type: string;
    mutable: boolean;
    global?: boolean;
}

export interface IRTypeDef extends IREntityDefinitionBase {
    kind: "type";
    namespace: IRNamespace;
    isType: true;
}

export interface IRMethodDef extends IREntityDefinitionBase {
    kind: "method";
    body: IRInstruction[];
    namespace: IRNamespace;

    /** ID of the entity that represents the parameter in order  */
    parameterTypes: string[];

    /** ID of the entity that represents the return type */
    returnType: string;
}

export interface IRStructDef extends IREntityDefinitionBase {
    kind: "struct";
    fields: Set<IRStructFieldDef>;
    namespace: IRNamespace;
    isType: true;
}

export interface IRStructFieldDef extends IREntityDefinitionBase {
    kind: "struct-field";

    /** Entity ID of the field's parent struct */
    parent: string;
    initializer?: IRInstruction;
}

export interface IREnumDef extends IREntityDefinitionBase {
    kind: "enum";
    namespace: IRNamespace;
    isType: true;
}

export interface IREnumVariantDef extends IREntityDefinitionBase {
    kind: "enum-variant";
    value: number;
    /** Entity id of the variant's parent enum */
    parent: string;
    associatedType?: {
        /** Entity ID that defines the type, (NOT WASM Type) */
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
    IRIdentifier |
    IRAssignment |
    IRMatchCase |
    IRMatchExpression;

export interface IRWhileStatement extends IRNode {
    kind: "while-statement";
    condition: IRInstruction;
    namespace: IRNamespace;
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
    namespace: IRNamespace;
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

/** This instruction should return the value of the identifier. */
export interface IRIdentifier extends IRNode {
    kind: "identifier";
    id: string;
    label: string;
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

/**
 * A WASM Type header
 */
export type WASMType =
    IRValueWASMType |
    IRMultiValueWASMType |
    IRFunctionWASMType;

export interface IRValueWASMType extends WASMTypeBase {
    kind: "value";
    binaryenType: number;
    mutable: boolean;
}

export interface IRMultiValueWASMType extends WASMTypeBase {
    kind: "multi-value";
    binaryenType: number[];
    mutable: boolean;
}

export interface IRFunctionWASMType extends WASMTypeBase {
    kind: "function";
    parameters: WASMType[];
    locals: WASMType[];
    returnType: WASMType;
}

export interface WASMTypeBase {
    id: string;
    kind: string;
}

/** A set of identifier ids accessible to the namespace owner */
export interface IRNamespace {
    /** Entities by label */
    entities: Set<string>;

    /** Labels already taken, except by methods */
    labels: Set<string>;
};

export interface IRBlockContext {
    ir: IR,
    namespace: IRNamespace,
    entities: IREntity[],
    body: IRInstruction[]
}
