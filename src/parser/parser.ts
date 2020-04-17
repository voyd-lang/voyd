import { Token } from "../lexer";
import { Block, Instruction, VariableDeclaration, TypeArgument, DreamNode, MethodDeclaration, ParameterDeclaration } from "./definitions";
import { isInTuple } from "../helpers";

export function parser(tokens: Token[]): Block {
    const ast: Block = { kind: "block", body: [] };

    while (tokens.length > 0) {
        const next = tokens[0];
        if (next.type === "}") {
            tokens.shift();
            break;
        }

        ast.body.push(parseStatement(tokens));
    }

    return ast;
}

function parseStatement(tokens: Token[], terminator?: Token): Instruction {
    while (tokens.length > 0) {
        let token = tokens[0];

        // Ignore newlines and semicolons
        if (isInTuple(token.type, ["\n", ";"])) {
            tokens.shift();
            continue;
        }

        if (token.type === "keyword" && isInTuple(token.value, ["let", "var"])) {
            return parseVariableDeclaration(tokens);
        }

        if (token.type === "keyword" && isInTuple(token.value, ["async", "mut", "def"])) {
            return parseMethodDeclaration(tokens);
        }

        return parseExpression(tokens);
    }

    throw new Error("Invalid statement");
}

function parseMethodDeclaration(tokens: Token[]): MethodDeclaration {
    const flags: string[] = [];

    while (tokens[0].type === "keyword" && isInTuple(tokens[0].value, ["async", "mut", "def"])) {
        flags.push(tokens.shift()!.value);
    }

    const identifier = tokens.shift()!.value;
    const parameters = parseMethodParameters(tokens);

    let returnType: TypeArgument | undefined;
    if (tokens[0].type === "->") {
        tokens.shift();
        returnType = parseTypeArgument(tokens);
    }

    if (tokens[0].type !== "{") {
        throw new Error(`Unexpected token in method declaration: ${tokens[0].type}`);
    }
    tokens.shift();

    const body = parser(tokens);

    return {
        kind: "method-declaration",
        identifier,
        parameters,
        returnType,
        body,
        typeParameters: [], // TODO
        flags
    }
}

function parseMethodParameters(tokens: Token[]): ParameterDeclaration[] {
    const params: ParameterDeclaration[] = [];

    const openingBracket = tokens.shift();
    if (!openingBracket || !isInTuple(tokens[0].type, <const>["("])) {
        throw new Error("Method definition missing parameters");
    }

    // In the future, we will support "]" as well
    const closeBracket = <const>")";

    let token = tokens.shift();
    while (token && token.type !== closeBracket) {
        if (token.type === "identifier") {
            params.push(parseParameter(tokens));
            token = tokens.shift();
            continue;
        }

        if (token.type === ",") {
            token = tokens.shift();
            continue;
        }

        throw new Error(`Invalid token in parameters: ${token.type}`);
    }

    return params;
}

function parseParameter(tokens: Token[]): ParameterDeclaration {
    const flags: string[] = [];

    const identifierToken = tokens.shift();
    if (!identifierToken || identifierToken.type !== "identifier") {
        throw new Error("Invalid parameter definition");
    }

    const identifier = identifierToken.value;

    const separator = tokens.shift();
    if (!separator || !isInTuple(separator.value, <const>[":", "="])) {
        throw new Error("Unexpected token in parameter definition");
    }

    if (separator.value === "=") {
        const initializer = parseExpression(tokens);
        return {
            kind: "parameter-declaration",
            identifier,
            initializer,
            flags
        }
    }

    let token = tokens.shift();
    while (token && isInTuple(token.value, <const>["mut", "ref"])) {
        flags.push(token.value);
        token = tokens.shift();
    }

    const type = parseTypeArgument(tokens);

    return {
        kind: "parameter-declaration",
        identifier,
        type,
        flags
    }
}

function parseVariableDeclaration(tokens: Token[]): VariableDeclaration {
    const flags: string[] = [];
    const identifiers: string[] = [];
    let type: TypeArgument | undefined = undefined;
    let initializer: DreamNode | undefined;

    if (isInTuple(tokens[0].value, ["let", "var"])) {
        flags.push(tokens.shift()!.value);
    }

    while (isInTuple(tokens[0].type, <const>["identifier", ","])) {
        if (tokens[0].type === ",") {
            tokens.shift();
            continue;
        }

        identifiers.push(tokens[0].value)
    }

    if (tokens[0].type === ":") {
        tokens.shift();
        type = parseTypeArgument(tokens);
    }

    if (tokens[0].value === "=") {
        tokens.shift();
        initializer = parseExpression(tokens);
    }

    return {
        kind: "variable-declaration",
        identifiers, flags, type, initializer
    };
}

function parseTypeArgument(tokens: Token[]): TypeArgument {
    const token = tokens.shift()!;
    // For now we assume a simple type as an identifier.
    return {
        kind: "type-argument",
        identifier: token.value,
        flags: []
    };
}

function parseExpression(tokens: Token[], terminator?: Token): Instruction {
    const output: Instruction[] = [];
    const operator: Token[] = [];

    while (tokens.length > 0) {
        const token = tokens[0];

        // Ignore new lines for now
        if (token.type === "\n") {
            tokens.shift();
            continue;
        }

        // Consumed terminator
        if (terminator && token.type === terminator.type) {
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
            if (token.value === "if") {
                tokens.shift();
                const condition = parseExpression(tokens, { type: "{", value: "{" });
                const body = [parser(tokens)]; // [] is temp type hack
                output.push({ kind: "if-expression", condition, body });
                continue;
            }

            throw new Error(`Invalid keyword in expression: ${token.value}`);
        }

        if (token.type === "identifier") {
            const next = tokens[1];
            if (next && isInTuple(next.type, ["(", "["])) {
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

        if (token.type === "(") {
            tokens.shift();
            output.push(parseExpression(tokens));
            tokens.shift();
            continue;
        }

        // Non-consumed terminators
        if (isInTuple(token.type, ["}", ")", ","])) break;

        throw new Error(`Unexpected token: ${token}`);
    }

    // Infix parsing
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
    while (token.type !== ")") {
        if (token.type !== ",") {
            tokens.shift();
        }

        args.push(parseExpression(tokens))
        token = tokens[0];
    }
    tokens.shift(); // Remove right paren;

    return args;
}
