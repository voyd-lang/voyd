import { Token, operators, keywords, brackets, symbols, symbolAndOperatorChars } from "./definitions";
import { isInTuple } from "../helpers";

export function tokenize(code: string) {
    const chars = code.split("");
    const tokens: Token[] = [];
    while (chars.length > 0) {
        const char = chars[0];
        const next = chars[1];

        if (isLetter(char)) {
            const word = extractWord(chars);
            if (isKeyword(word)) {
                tokens.push({ type: "keyword", value: word, index: tokens.length });
                continue;
            }

            if (isOperator(word)) {
                tokens.push({ type: "operator", value: word, index: tokens.length });
                continue;
            }

            if (isBool(word)) {
                tokens.push({ type: "boolean", value: word, index: tokens.length });
                continue;
            }

            tokens.push({ type: "identifier", value: word, index: tokens.length });
            continue;
        }

        if (char === "/" && next === "/") {
            extractSingleLineComment(chars);
            continue;
        }

        if (char === "/" && next === "*") {
            extractMultilineComment(chars);
            continue;
        }

        // May push this to the parser later.
        if (char === "-" && isNum(next)) {
            chars.shift(); // Eat the -
            const { num, type } = extractNum(chars);
            tokens.push({ type, value: `-${num}`, index: tokens.length });
            continue;
        }

        if (isNum(char)) {
            const { num, type } = extractNum(chars);
            tokens.push({ type, value: num, index: tokens.length });
            continue;
        }

        if (char === "\"") {
            tokens.push({ type: "string", value: extractString(chars), index: tokens.length });
            continue;
        }

        if (isSymbolOrOperatorChar(char)) {
            const value = extractSymbolOrOperator(chars);
            if (isInTuple(value, symbols)) {
                tokens.push({ type: value, value, index: tokens.length });
                continue;
            }

            if (isOperator(value)) {
                tokens.push({ type: "operator", value, index: tokens.length });
                continue;
            }

            // Handles | overlap
            if (isInTuple(value, brackets)) {
                tokens.push({ type: value, value, index: tokens.length });
                continue;
            }

            throw new Error(`Unknown operator or symbol: ${value}`);
        }

        if (isInTuple(char, brackets)) {
            tokens.push({ type: char, value: chars.shift()!, index: tokens.length });
            continue;
        }

        if (isInTuple(char, [" ", "\r", "\t", "\n"])) {
            chars.shift();
            continue;
        }

        throw new Error(`Unexpected token: ${char}`);
    }

    return tokens;
}

const isLetter = (char: string) => (/[a-zA-Z]|_/g).test(char);

const isNum = (char: string) => (/[0-9]/g).test(char);

const isOperator = (str: string) => isInTuple(str, operators);

const isSymbolOrOperatorChar = (str: string) => isInTuple(str, symbolAndOperatorChars);

const isKeyword = (str: string) => isInTuple(str, keywords);

const isBool = (str: string) => str === "true" || str === "false";

const extractSingleLineComment = (chars: string[]) => {
    while (chars[0] !== "\n") chars.shift();
}

const extractMultilineComment = (chars: string[]) => {
    while (chars[0] !== "*" || chars[1] !== "/") {
        chars.shift();
    }
    chars.shift();
    chars.shift();
}

// TODO: This can probably just be a simple regex.
const extractWord = (chars: string[]) => {
    let word = "";
    while (chars[0] && (isLetter(chars[0]) || isNum(chars[0]))) {
        word += chars.shift();
    }
    return word;
};

const extractNum = (chars: string[]) => {
    let hadDot = false;
    let num = "";

    while (chars.length > 0) {
        const next = chars[0];
        if (next === "." && hadDot) break;

        if (next === ".") {
            hadDot = true;
            num += chars.shift();
            continue;
        }

        if (isNum(next)) {
            num += chars.shift();
            continue;
        }

        break;
    }

    return { num, type: (hadDot ? "float" : "int") as ("float" | "int") };
};

const extractString = (chars: string[]) => {
    chars.shift(); // Eat the leading "

    let string = "";
    while (chars.length > 0) {
        const char = chars.shift();
        if (char === "\"") break;
        string += char;
    }

    return string;
}

const extractSymbolOrOperator = (chars: string[]) => {
    let op = "";
    while (isSymbolOrOperatorChar(chars[0])) {
        op += chars.shift();
    }
    return op;
}
