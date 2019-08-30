
export type TokenType =
    "int" | "double" | "string" | "fn" | "interface" | "object" |
    "enum" | "case" | "let" | "var" | "if" | "else" | "for" | "in" |
    "self" | "return" | "yeild" | "async" | "await" | "identifier" |
    "operator" | "colon" | "equal" | "left-paren" | "right-paren" |
    "left-curly" | "right-curly" | "left-square" | "right-square" |
    "indent" | "new-line" | "comment" | "false" | "true" | "comma";

export interface Token {
    type: TokenType;
    value: string;
    line: number;
}

export type Tokens = Token[];
