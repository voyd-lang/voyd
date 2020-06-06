
export interface IREntities {
    /** Where key is the unique id of the identifier, and value is the key of the type */
    [id: string]: IREntity;
}

///////////////////////////////
///////////////////////////////
///// IREntities
///////////////////////////////
///////////////////////////////

/** Any item that can be referenced by an identifier */
export type IREntity =
    IRFunctionEntity |
    IRTypeEntity |
    IRValueEntity;

export type IREntityWithoutID =
    Omit<IRFunctionEntity, "id"> |
    Omit<IRTypeEntity, "id"> |
    Omit<IRValueEntity, "id">;

export interface IRFunctionEntity extends IREntityBase {
    kind: "function";

    /** Entity ID */
    parameters: string[];

    /** Entity ID */
    locals: string[];

    /** Entity ID */
    returnType?: string;

    body: IRInstruction[];
}

/** Represents types such as structs, enums, and type aliases. i.e. `type Foo =` or `declare type` */
export interface IRTypeEntity extends IREntityBase {
    kind: "type";
    typeEntity?: string;
}


export interface IRValueEntity extends IREntityBase {
    kind: "value";
    typeEntity: string;
}

/** A declared definition */
export interface IREntityBase {
    kind: string;
    id: string;
    label: string;
    flags: string[];

    /** Namespace ID */
    namespace: string;
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
    IRMatchExpression |
    IRNoOP |
    IRBlockExpression;

export interface IRNoOP extends IRNode {
    kind: "no-op";
}

export interface IRWhileStatement extends IRNode {
    kind: "while-statement";
    condition: IRInstruction;
    namespace: string;
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
    namespace: string;
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

export interface IRBlockExpression extends IRNode {
    kind: "block-expression";
    body: IRInstruction[];
    flags: string[];
    namespace: string;
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
    identifierEntityID: string;
    label: string;
}

export interface IRAssignment extends IRNode {
    kind: "assignment";
    /** identifier id */
    assigneeEntityID: string;
    /** identifier label */
    label: string;
    expression: IRInstruction;
}

export interface IRNode {
    kind: string;
}
