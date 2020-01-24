import { Token } from "./definitions";

const operators = [
    "+", "-", "*", "/", "=", "==", "and", "or", "xor", "<", ">", ">=", "<=", "<>",
    "=>", "??", "|>"
];

const keywords = ["let", "var", "for", "in", "return", "break", "continue", "if", "else", "elif", "while"];

const isLetter = (char: string) => (/[a-zA-Z]|_/g).test(char);

const isNum = (char: string) => (/[0-9]/g).test(char);

const isOperator = (str: string) => operators.includes(str);

const isKeyword = (str: string) => keywords.includes(str);

const isBool = (str: string) => str === "true" || str === "false";

const extractWord = (chars: string[]) => {
    let word = "";
    while (isLetter(chars[0]) || isNum(chars[0])) {
        word += chars.shift();
    }
    return word;
};

const extractNum = (chars: string[]) => {
    let hasHadDot = false;
    let num = "";
    while (chars.length > 0) {
        const next = chars[0];
        if (next === "." && hasHadDot) break;

        if (next === ".") {
            hasHadDot = true;
            num += chars.shift();
            continue;
        }

        if (isNum(next)) {
            num += chars.shift();
            continue;
        }

        break;
    }
    return num;
};

const extractString = (chars: string[]) => {
    let string = "";
    while (chars.length > 0) {
        const char = chars.shift();
        if (char === "\"") break;
        string += char;
    }
    return string;
}

const extractOperator = (chars: string[]) => {
    let op = "";
    while (isOperator(chars[0])) {
        op += chars.shift();
    }
    return op;
}


export const lexer = (code: string) => {
    const chars = code.split("");

    const tokens: Token[] = [];
    while (chars.length > 0) {
        const char = chars.shift()!;
        const next = chars[0];

        if (char === ";") {
            tokens.push({ type: ";", value: char });
            continue;
        }

        if (isLetter(char)) {
            const word = `${char}${extractWord(chars)}`;
            if (isKeyword(word)) {
                tokens.push({ type: "keyword", value: word });
                continue;
            }

            if (isOperator(word)) {
                tokens.push({ type: "operator", value: word });
                continue;
            }

            if (isBool(word)) {
                tokens.push({ type: "boolean", value: word });
                continue;
            }

            tokens.push({ type: "identifier", value: word });
            continue;
        }

        if (char === "-" && isNum(next)) {
            tokens.push({ type: "number", value: `-${extractNum(chars)}` });
            continue;
        }

        if (isNum(char)) {
            tokens.push({ type: "number", value: `${char}${extractNum(chars)}` });
            continue;
        }

        if (char === "\"") {
            tokens.push({ type: "string", value: extractString(chars) });
            continue;
        }

        if (char === "|") {
            tokens.push({ type: "pipe", value: "|" });
            continue;
        }

        if (char === "{") {
            tokens.push({ type: "left-curly", value: "{" });
            continue;
        }

        if (char === "}") {
            tokens.push({ type: "right-curly", value: "}" });
            continue;
        }

        if (char === "(") {
            tokens.push({ type: "left-paren", value: "(" });
            continue;
        }

        if (char === ")") {
            tokens.push({ type: "right-paren", value: ")" });
            continue;
        }

        if (isOperator(char)) {
            const fullOp = `${char}${extractOperator(chars)}`;
            if (!isOperator(fullOp)) {
                throw new Error(`Unkown operator: ${fullOp}`);
            }
            tokens.push({ type: "operator", value: fullOp });
            continue;
        }

        if (char === ",") {
            tokens.push({ type: "comma", value: "," });
            continue;
        }

        if (char === " " || char === "\t" || char === "\r" || char === "\n") continue;

        throw new Error(`Unexpected token: ${char}`);
    }

    return tokens;
}
