import { Token } from "../lexer";
import { AST } from "./definitions";


const operatorPrecedence = (operator: string): number => {
    const precedences: Record<string, number> = {
        "and": 1,
        "or": 1,
        "xor": 1,
        "==": 2,
        "<": 2,
        ">": 2,
        ">=": 2,
        "<=": 2,
        "<>": 2,
        "?": 2,
        "+": 2,
        "-": 2,
        "*": 3,
        "/": 3,
        "^": 4,
        ".": 5,
        "=": 0,
        "=>": 0
    }
    return precedences[operator];
}

const parseFnCall = (tokens: Token[]): AST => {
    const ast: AST = [];

    let token = tokens[0];
    while (token.type !== "bracket" && token.value !== ")") {
        if (token.type === "symbol" && token.value !== ",") {
            tokens.shift();
        }

        ast.push(parseStatement(tokens))
        token = tokens[0];
    }
    tokens.shift(); // Remove right paren;

    return ast;
}

const parseArgs = (tokens: Token[]): string[] => {
    const args: string[] = [];

    let token = tokens.shift()!;
    while (token.type !== "pipe") {
        if (token.type === "comma") {
            token = tokens.shift()!;
            continue;
        }

        args.push(token.value);
        token = tokens.shift()!;
    }

    return args;
}

const parseStatement = (tokens: Token[], terminator?: Token): Instruction => {
    const output: AST = [];
    const operator: Token[] = [];

    while (tokens.length > 0) {
        const token = tokens[0];

        if (terminator && token.type === terminator.type && token.value === terminator.value) {
            tokens.shift();
            break;
        }

        if (token.type === "number") {
            output.push({ type: "number", value: Number(token.value) });
            tokens.shift();
            continue;
        }

        if (token.type === "string") {
            output.push({ type: "string", value: token.value });
            tokens.shift();
            continue;
        }

        if (token.type === "boolean") {
            output.push({ type: "boolean", value: token.value === "true" });
            tokens.shift();
            continue;
        }

        if (token.type === "keyword") {
            if (token.value === "let") {
                const next = tokens[1];
                output.push({ type: "variable-declaration", name: next.value, varType: "let" });
                tokens.shift();
                break;
            }

            if (token.value === "var") {
                const next = tokens[1];
                output.push({ type: "variable-declaration", name: next.value, varType: "var" });
                tokens.shift();
                break;
            }

            if (token.value === "if") {
                tokens.shift();
                const condition = parseStatement(tokens, { type: "left-curly", value: "{" });
                const body = parser(tokens);
                output.push({ type: "if", condition, body });
                continue;
            }


            if (token.value === "while") {
                tokens.shift();
                const condition = parseStatement(tokens, { type: "left-curly", value: "{" });
                const body = parser(tokens);
                output.push({ type: "while", condition, body });
                continue;
            }

            if (token.value === "return") {
                tokens.shift();
                output.push({ type: "return", exp: parseStatement(tokens) });
                continue;
            }

            if (token.value === "break") {
                tokens.shift();
                output.push({ type: "break", exp: parseStatement(tokens) });
                continue;
            }

            if (token.value === "continue") {
                tokens.shift();
                output.push({ type: "continue" });
                continue;
            }

            throw new Error(`Unknown keyword: ${token.value}`);
        }

        if (token.type === "identifier") {
            const next = tokens[1];
            if (next && next.type === "left-paren") {
                tokens.shift();
                tokens.shift();
                output.push({
                    type: "function-call",
                    function: token.value,
                    args: parseFnCall(tokens),
                });
                continue;
            }

            output.push({ type: "identifier", name: token.value });
            tokens.shift();
            continue;
        }

        if (token.type === "operator") {
            while (operator.length > 0) {
                const op = operator[operator.length - 1];
                if (operatorPrecedence(op.value) >= operatorPrecedence(token.value)) {
                    output.push({
                        type: "function-call",
                        function: operator.pop()!.value,
                        args: [output.pop()!, output.pop()!]
                    });
                    continue;
                }
                break;
            }

            operator.push(tokens.shift()!);
            continue;
        }

        if (token.type === "pipe") {
            tokens.shift();
            const args = parseArgs(tokens);
            tokens.shift(); // Get rid of left curly;
            output.push({ type: "function", args, body: parser(tokens) });
            continue;
        }

        if (token.type === "left-paren") {
            tokens.shift();
            output.push(parseStatement(tokens));
            tokens.shift();
            continue;
        }

        if (token.type === "left-curly") {
            tokens.shift();
            output.push(parser(tokens));
            continue;
        }

        // Non-consumed terminator
        if (token.type === "right-curly") {
            break;
        }

        // Non-consumed terminator
        if (token.type === "right-paren") {
            break;
        }

        // Non-consumed terminator
        if (token.type === "comma") {
            break;
        }

        if (token.type === "terminator") {
            tokens.shift();
            break;
        }

        throw new Error(`Unexpected token: ${token}`);
    }

    while (operator.length > 0) {
        output.push({
            type: "function-call",
            function: operator.pop()!.value,
            args: [output.pop()!, output.pop()!]
        });
    }

    return output[0] as Instruction;
}

export const parser = (tokens: Token[]): AST => {
    const ast: AST = [];

    while (tokens.length > 0) {
        if (tokens[0].type === "right-curly") {
            tokens.shift();
            break;
        }

        ast.push(parseStatement(tokens));
    }

    return ast;
}
