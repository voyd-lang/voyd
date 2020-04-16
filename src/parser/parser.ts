import { Token } from "../lexer";
import { Block, Instruction } from "./definitions";
import { isInTuple } from "../helpers";

export function parser(tokens: Token[]): Block {
    const ast: Block = { kind: "block", body: [] };

    while (tokens.length > 0) {
        const next = tokens[0];
        if (next.type === "bracket" && next.value === "}") {
            tokens.shift();
            break;
        }

        ast.body.push(parseStatement(tokens));
    }

    return ast;
}

// TODO: Expression parser.

function parseStatement(tokens: Token[], terminator?: Token): Instruction {
    const output: Instruction[] = [];
    const operator: Token[] = [];

    while (tokens.length > 0) {
        const token = tokens[0];

        if (terminator && token.type === terminator.type && token.value === terminator.value) {
            tokens.shift();
            break;
        }

        if (token.type === "int") {
            output.push({ kind: "i32-literal", value: token.value });
            tokens.shift();
            continue;
        }

        if (token.type === "float") {
            output.push({ kind: "f32-literal", value: token.value });
            tokens.shift();
            continue;
        }

        if (token.type === "string") {
            output.push({ kind: "string-literal", value: token.value });
            tokens.shift();
            continue;
        }

        if (token.type === "boolean") {
            output.push({ kind: "bool-literal", value: token.value === "true" });
            tokens.shift();
            continue;
        }

        if (token.type === "keyword") {
            if (token.value === "let") {
                const next = tokens[1];
                output.push({
                    kind: "variable-declaration",
                    identifier: next.value,
                    flags: ["let"],
                    initializer: { kind: "todo" }
                });
                tokens.shift();
                break;
            }

            if (token.value === "var") {
                const next = tokens[1];
                output.push({
                    kind: "variable-declaration",
                    identifier: next.value,
                    flags: ["var"],
                    initializer: { kind: "todo" }
                });
                tokens.shift();
                break;
            }

            if (token.value === "if") {
                tokens.shift();
                const condition = parseStatement(tokens, { type: "bracket", value: "{" });
                const body = [parser(tokens)]; // [] is temp type hack
                output.push({ kind: "if-expression", condition, body });
                continue;
            }


            if (token.value === "while") {
                tokens.shift();
                const condition = parseStatement(tokens, { type: "bracket", value: "{" });
                const body = [parser(tokens)]; // [] is temp type hack
                output.push({ kind: "while-statement", condition, body });
                continue;
            }

            if (token.value === "return") {
                tokens.shift();
                output.push({ kind: "return-statement", expression: parseStatement(tokens) });
                continue;
            }

            if (token.value === "break") {
                tokens.shift();
                output.push({ kind: "break-statement" });
                continue;
            }

            if (token.value === "continue") {
                tokens.shift();
                output.push({ kind: "continue-statement" });
                continue;
            }

            throw new Error(`Unknown keyword: ${token.value}`);
        }

        if (token.type === "identifier") {
            const next = tokens[1];
            if (next && next.type === "bracket" && isInTuple(next.value, ["(", "["])) {
                tokens.shift();
                tokens.shift();
                output.push({
                    kind: "method-or-function-call",
                    identifier: token.value,
                    arguments: parseArguments(tokens),
                });
                continue;
            }

            output.push({ kind: "identifier", value: token.value });
            tokens.shift();
            continue;
        }

        if (token.type === "operator") {
            while (operator.length > 0) {
                const op = operator[operator.length - 1];
                if (getOperatorPrecedence(op.value) >= getOperatorPrecedence(token.value)) {
                    output.push({
                        kind: "method-or-function-call",
                        identifier: operator.pop()!.value,
                        arguments: [output.pop()!, output.pop()!]
                    });
                    continue;
                }
                break;
            }

            operator.push(tokens.shift()!);
            continue;
        }

        if (token.type === "bracket" && token.value === "(") {
            tokens.shift();
            output.push(parseStatement(tokens));
            tokens.shift();
            continue;
        }

        if (token.type === "bracket" && token.value === "{") {
            tokens.shift();
            output.push(parser(tokens));
            continue;
        }

        // Non-consumed terminator
        if (token.type === "bracket" && isInTuple(token.value, ["}", ")"])) {
            break;
        }

        // Non-consumed terminator
        if (token.type === "symbol" && token.value === ",") {
            break;
        }

        throw new Error(`Unexpected token: ${token}`);
    }

    while (operator.length > 0) {
        output.push({
            kind: "method-or-function-call",
            identifier: operator.pop()!.value,
            arguments: [output.pop()!, output.pop()!]
        });
    }

    return output[0] as Instruction;
}

function getOperatorPrecedence(operator: string): number {
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

function parseArguments(tokens: Token[]): Instruction[] {
    const args: Instruction[] = [];

    let token = tokens[0];
    while (token.type !== "bracket" && token.value !== ")") {
        if (token.type === "symbol" && token.value !== ",") {
            tokens.shift();
        }

        args.push(parseStatement(tokens))
        token = tokens[0];
    }
    tokens.shift(); // Remove right paren;

    return args;
}

function parseParameters(tokens: Token[], closeBracket: "]" | ")" = ")"): string[] {
    const args: string[] = [];

    let token = tokens.shift()!;
    while (token.type !== "bracket" && token.value !== closeBracket) {
        if (token.type === "symbol" && token.value === ",") {
            token = tokens.shift()!;
            continue;
        }

        args.push(token.value);
        token = tokens.shift()!;
    }

    return args;
}
