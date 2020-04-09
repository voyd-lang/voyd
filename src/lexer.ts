import { Token, operators, keywords, brackets, symbols } from "./definitions";
import { isInTuple } from "./helpers";

const isLetter = (char: string) => (/[a-zA-Z]|_/g).test(char);

const isNum = (char: string) => (/[0-9]/g).test(char);

const isOperator = (str: string) => isInTuple(str, operators);

const isKeyword = (str: string) => isInTuple(str, keywords);

const isBool = (str: string) => str === "true" || str === "false";

const extractWord = (chars: string[]) => {
    let word = "";
    while (isLetter(chars[0]) || isNum(chars[0])) {
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

    return { num, type: (hadDot ? "double" : "int") as ("double" | "int") };
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
            const { num, type } = extractNum(chars);
            tokens.push({ type, value: `-${num}` });
            continue;
        }

        if (isNum(char)) {
            const { num, type } = extractNum(chars);
            tokens.push({ type, value: `${char}${num}` });
            continue;
        }

        if (char === "\"") {
            tokens.push({ type: "string", value: extractString(chars) });
            continue;
        }

        if (isInTuple(char, brackets)) {
            tokens.push({ type: "bracket", value: char });
            continue;
        }

        if (isInTuple(char, symbols)) {
            tokens.push({ type: "symbol", value: char });
            continue;
        }

        if (char === "-" && next === ">") {
            tokens.push({ type: "symbol", value: "->" });
            continue;
        }

        if (isOperator(char)) {
            const fullOp = `${char}${extractOperator(chars)}`;
            if (!isOperator(fullOp)) {
                throw new Error(`Unknown operator: ${fullOp}`);
            }
            tokens.push({ type: "operator", value: fullOp });
            continue;
        }

        if (char === " " || char === "\t" || char === "\r") continue;

        throw new Error(`Unexpected token: ${char}`);
    }

    return tokens;
}
