export type Token = {
    type:
    "operator" | "keyword" | "identifier" | "bracket" | "symbol" |
    "boolean" | "string" | "int" | "double";
    value: string;
}

export interface Statement {
    type: string;
}

export interface DreamFunction extends Statement {
    type: "function";
    args: { type: string, label: string, callLabel: string }[];
    body: AST;
}

export interface FunctionCall extends Statement {
    type: "function-call";
    function: string;
    args: { label: string, value: AST }
}

export interface DreamInt extends Statement {
    type: "int";
    value: string;
}

export interface DreamDouble extends Statement {
    type: "double";
    value: string;
}

export interface DreamString extends Statement {
    type: "string";
    value: string;
}

export interface DreamBool extends Statement {
    type: "boolean";
    value: boolean;
}

export interface ValueDeclaration extends Statement {
    type: "variable-declaration";
    name: string;
    valType: string;
    bindingType: "let" | "var";
}

export interface IfStatement extends Statement {
    type: "if";
    condition: AST | Instruction;
    body: AST | Instruction;
}

export interface ReturnStatement extends Statement {
    type: "return";
    exp: AST | Instruction;
}

export interface BreakStatement extends Statement {
    type: "break";
    exp: AST | Instruction;
}

export interface ContinueStatement extends Statement {
    type: "continue";
}

export interface WhileStatement extends Statement {
    type: "while";
    condition: AST | Instruction;
    body: AST | Instruction;
}

export interface ForStatement extends Statement {
    type: "for";
    condition: AST | Instruction;
    body: AST | Instruction;
}

export interface DreamIdentifier extends Statement {
    type: "identifier";
    name: string;
}

export type Instruction =
    DreamFunction |
    FunctionCall |
    DreamInt |
    DreamDouble |
    DreamBool |
    DreamString |
    ValueDeclaration |
    IfStatement |
    WhileStatement |
    DreamIdentifier |
    BreakStatement |
    ContinueStatement |
    ReturnStatement;

export interface AST extends Array<Instruction | AST> { }

export const operators = [
    "+", "-", "*", "/", "=", "==", "and", "or", "xor", "<", ">", ">=", "<=", "<>",
    "=>", "??", "||", '&'
] as const;

export const keywords = [
    "let", "var", "for", "in", "return", "break", "continue", "if", "else", "while", "def", "get",
    "set", "struct", "class", "pub", "mut"
] as const;

export const brackets = ["{", "}", "[", "]", "(", ")", "|"] as const;

export const symbols = [".", "?", ":", ";", ",", "\n", "->", "$"] as const;
