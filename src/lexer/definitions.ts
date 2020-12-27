export type Token = {
    type: TokenType;
    value: string;
    index: number;
}

export type TokenType = "operator" | "keyword" | "identifier" | "boolean" | "string" | "int" | "float" |
    "{" | "}" | "[" | "]" | "(" | ")" | "|" | "'" |
    ":" | ";" | "," | "?" | "->" | "=>" | "$" | "&" | "!";

export const operators = [
    "+", "-", "*", "/", "==", "!=", "and", "or", "xor", "<", ">", ">=", "<=", "<>",
    "??", ".", "|>", "|<", "<|", "|>", "<<", ">>", "=", "as"
] as const;

export const keywords = [
    "let", "var", "for", "in", "return", "break", "continue", "if", "else", "elif", "while", "fn",
    "struct", "class", "pub", "mut", "guard", "async", "await", "ref", "final", "static",
    "use", "from", "unsafe", "macro", "impl", "match", "case", "guard", "enum",
    "lazy", "pure", "declare", "type", "wasm_type"
] as const;

export const brackets = ["{", "}", "[", "]", "(", ")", "|", "'"] as const;

export const symbols = ["?", ":", ";", ",", "->", "$", "=>", "&", "!"] as const;

export const symbolAndOperatorChars = [
    "+", "-", "*", "/", "=", "!", "<", ">", "?", ":", ".", ";", ",", "$",
    "&", "|"
] as const;
