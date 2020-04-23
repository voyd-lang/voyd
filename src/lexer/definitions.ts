export type Token = {
    type:
    "operator" | "keyword" | "identifier" | "boolean" | "string" | "int" | "float" |
    "{" | "}" | "[" | "]" | "(" | ")" | "|" | "'" |
    ":" | ";" | "," | "?" | "->" | "=>" | "$" | "\n" | "=" | "&" | "!";
    value: string;
}

export const operators = [
    "+", "-", "*", "/", "==", "!=", "and", "or", "xor", "<", ">", ">=", "<=", "<>",
    "??", "."
] as const;

export const keywords = [
    "let", "var", "for", "in", "return", "break", "continue", "if", "else", "while", "def", "get",
    "set", "struct", "class", "pub", "mut", "guard", "async", "await", "ref", "final", "static",
    "import", "from"
] as const;

export const brackets = ["{", "}", "[", "]", "(", ")", "|", "'"] as const;

export const symbols = ["?", ":", ";", ",", "->", "$", "\n", "=>", "=", "&", "!"] as const;
