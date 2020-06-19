import { Token, tokenize, operators } from "../lexer";
import {
    Instruction, VariableDeclaration, TypeArgument, FunctionDeclaration, ParameterDeclaration,
    ReturnStatement, Assignment, EnumDeclaration, EnumVariantDeclaration, MatchCase, Identifier, AST, BlockExpression, TypeDeclaration, PropertyAccessExpression, ImplDeclaration, ASTNode
} from "./definitions";
import { isInTuple } from "../helpers";
import { Scope } from "../scope";

export function parse(code: string): AST {
    const tokens = tokenize(code);
    const scope = new Scope();
    return { body: parseTokens(tokens, scope), scope };
}

function parseTokens(tokens: Token[], scope: Scope): Instruction[] {
    const instructions: Instruction[] = [];

    while (tokens.length > 0) {
        const next = tokens[0];
        if (next.type === "}") {
            tokens.shift();
            break;
        }

        if (next.type === "\n") {
            tokens.shift();
            continue;
        }

        instructions.push(parseStatement(tokens, scope));
    }

    return instructions;
}

function parseStatement(tokens: Token[], scope: Scope): Instruction {
    while (tokens.length > 0) {
        let token = tokens[0];
        const next = tokens[1];

        // Ignore newlines and semicolons
        if (isInTuple(token.type, ["\n", ";"] as const)) {
            tokens.shift();
            continue;
        }

        if (token.type === "keyword") {
            return parseKeywordStatement(tokens, scope);
        }

        if (token.type === "identifier" && next && next.type === "=") {
            return parseAssignment(tokens, scope);
        }

        return parseExpression(tokens, scope);
    }

    throw new Error("Invalid statement");
}

function parseKeywordStatement(tokens: Token[], scope: Scope): Instruction {
    let token = tokens[0];

    if (token.value === "return") {
        return parseReturnStatement(tokens, scope);
    }

    if (["if", "while", "for", "match"].includes(token.value)) {
        return parseExpression(tokens, scope);
    }

    if (token.value === "continue") {
        return { kind: "continue-statement" };
    }

    if (token.value === "break") {
        return { kind: "break-statement" };
    }

    const flags: string[] = [];
    while (token.type === "keyword") {
        flags.push(tokens.shift()!.value);
        token = tokens[0];
    }

    if (flags.some(val => val === "let" || val === "var")) {
        return parseVariableDeclaration(tokens, flags, scope);
    }

    if (flags.includes("fn")) {
        return parseFnDeclaration(tokens, flags, scope);
    }

    if (flags.includes("enum")) {
        return parseEnumDeclaration(tokens, flags, scope);
    }

    if (flags.includes("type")) {
        return parseTypeDeclaration(tokens, flags, scope);
    }

    if (flags.includes("unsafe")) {
        return parseBlockExpression(tokens, flags, scope);
    }

    if (flags.includes("impl")) {
        return parseImplDeclaration(tokens, flags, scope);
    }

    console.log(flags);
    const keywordStr = flags.reduce((p, c) => `${p} ${c}`, "");
    throw new Error(`Expected statement after keyword(s):${keywordStr}`);
}

function parseAssignment(tokens: Token[], scope: Scope): Assignment {
    const assignee = parseIdentifierExpression(tokens);

    const equals = tokens.shift();
    if (!equals || equals.type !== "=") {
        throw new Error("Expected = token in assignment expression");
    }

    return {
        kind: "assignment",
        assignee,
        expression: parseExpression(tokens, scope)
    }
}

function parseReturnStatement(tokens: Token[], scope: Scope): ReturnStatement {
    const returnToken = tokens.shift();
    if (!returnToken || returnToken.value !== "return") {
        throw new Error("Expected return token");
    }

    return {
        kind: "return-statement",
        expression: parseExpression(tokens, scope)
    }
}

/** Parse a function, beginning after fn */
function parseFnDeclaration(tokens: Token[], flags: string[], scope: Scope): FunctionDeclaration {
    const identifierToken = tokens.shift();
    if (!identifierToken || identifierToken.type !== "identifier" && identifierToken.type !== "operator") {
        throw new Error("Expected identifier after function declaration");
    }

    const label = identifierToken.value;
    const parameters = parseFnParameters(tokens, scope);

    let returnType: TypeArgument | undefined;
    if (tokens[0].type === "->") {
        tokens.shift();
        returnType = parseTypeArgument(tokens);
    }

    let expression: Instruction | undefined;
    if (tokens[0].type === "{") {
        expression = parseExpression(tokens, scope);
    } else if (tokens[0].type === "=") {
        tokens.shift();
        expression = parseExpression(tokens, scope);
    } else if (flags.includes("declare")) {
        // Do nothing
    } else {
        throw new Error(`Unexpected token in function declaration: ${tokens[0].type}`);
    }

    return {
        kind: "function-declaration",
        label,
        parameters,
        returnType,
        expression,
        scope: scope.sub(),
        typeParameters: [], // TODO
        flags
    }
}

function parseFnParameters(tokens: Token[], scope: Scope): ParameterDeclaration[] {
    const params: ParameterDeclaration[] = [];

    const openingBracket = tokens.shift();
    if (!openingBracket || !isInTuple(openingBracket.type, <const>["("])) {
        throw new Error("Function definition missing parameters");
    }

    // In the future, we will support "]" as well
    const closeBracket = <const>")";

    let token = tokens[0];
    while (token && token.type !== closeBracket) {
        if (token.type === "identifier") {
            params.push(parseParameter(tokens, scope));
            token = tokens[0];
            continue;
        }

        if (token.type === ",") {
            tokens.shift();
            token = tokens[0];
            continue;
        }

        throw new Error(`Invalid token in parameters: ${token.type}`);
    }

    // Remove the closeBracket
    tokens.shift();

    return params;
}

function parseParameter(tokens: Token[], scope: Scope): ParameterDeclaration {
    const flags: string[] = [];

    const identifierToken = tokens.shift();
    if (!identifierToken || identifierToken.type !== "identifier") {
        throw new Error("Invalid parameter definition");
    }

    const label = identifierToken.value;

    const separator = tokens.shift();
    if (!separator || !isInTuple(separator.value, <const>[":", "="])) {
        throw new Error("Unexpected token in parameter definition");
    }

    if (separator.value === "=") {
        const initializer = parseExpression(tokens, scope);
        return {
            kind: "parameter-declaration",
            label,
            initializer,
            flags
        }
    }

    let token = tokens[0];
    while (token && isInTuple(token.value, <const>["mut", "ref"])) {
        flags.push(token.value);
        tokens.shift();
        token = tokens[0];
    }

    const type = parseTypeArgument(tokens);

    return {
        kind: "parameter-declaration",
        label,
        type,
        flags
    }
}

function parseVariableDeclaration(tokens: Token[], flags: string[], scope: Scope): VariableDeclaration {
    let type: TypeArgument | undefined = undefined;
    let initializer: Instruction | undefined;

    const labelToken = tokens.shift();
    if (!labelToken || labelToken.type !== "identifier") {
        throw new Error("Identifier expected");
    }

    if (tokens[0].type === ":") {
        tokens.shift();
        type = parseTypeArgument(tokens);
    }

    if (tokens[0].value === "=") {
        tokens.shift();
        initializer = parseExpression(tokens, scope);
    }

    return {
        kind: "variable-declaration",
        label: labelToken.value, flags, type, initializer
    };
}

function parseTypeArgument(tokens: Token[]): TypeArgument {
    const token = tokens.shift()!;
    // For now we assume a simple type as an identifier.
    return {
        kind: "type-argument",
        label: token.value,
        flags: []
    };
}

function parseExpression(tokens: Token[], scope: Scope, terminator?: Token, flags: string[] = []): Instruction {
    const output: Instruction[] = [];
    const operator: Token[] = [];

    // Since we don't use ; to terminate an expression, we can tell the expression
    // Is done if we get two non-operator tokens in a row (-newlines).
    // This is my ugly temp solution. Looking for a way to make it cleaner.
    let expectOperatorToContinue = false;
    while (tokens.length > 0) {
        const token = tokens[0];

        // Ignore new lines for now
        if (token.type === "\n") {
            tokens.shift();
            continue;
        }

        // Consumed terminator
        // TODO: !!! Important !!! Make this non consuming
        if (terminator && token.type === terminator.type) {
            tokens.shift();
            break;
        }

        if (token.type !== "operator") {
            if (expectOperatorToContinue) break;
            expectOperatorToContinue = true;
        } else {
            if (!expectOperatorToContinue) {
                throw new Error(`Unexpected operator: ${token.value}`);
            }

            expectOperatorToContinue = false;
        }

        if (token.type === "{") {
            tokens.shift();
            output.push({ kind: "block-expression", flags, body: parseTokens(tokens, scope), scope: scope.sub() });
            continue;
        }

        if (token.type === "int") {
            output.push({ kind: "int-literal", value: token.value });
            tokens.shift();
            continue;
        }

        if (token.type === "float") {
            output.push({ kind: "float-literal", value: token.value });
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
                parseIfExpression(tokens, output, scope);
                continue;
            }

            if (token.value === "while") {
                tokens.shift()
                const whileScope = scope.sub();
                const condition = parseExpression(tokens, whileScope, { type: "{", value: "{" });
                const body = parseTokens(tokens, whileScope);
                output.push({ kind: "while-statement", condition, body, scope: whileScope });
                continue;
            }

            if (token.value === "match") {
                tokens.shift();
                const expression = parseExpression(tokens, scope, { type: "{", value: "{" });
                const cases = parseMatchCases(tokens, scope);
                output.push({ kind: "match-expression", value: expression, cases, flags: [] });
                continue;
            }

            if (token.value === "unsafe") {
                tokens.shift();
                output.push(parseExpression(tokens, scope, undefined, ["unsafe"]));
                continue;
            }

            throw new Error(`Invalid keyword in expression: ${token.value}`);
        }

        if (token.type === "identifier") {
            let expr = parseIdentifierExpression(tokens);

            // Handle possible function / method call
            const next = tokens[0];
            if (next && isInTuple(next.type, ["(", "["])) {
                output.push({
                    kind: "call-expression",
                    callee: expr,
                    arguments: parseArguments(tokens, scope), // T
                });
                continue;
            }

            output.push(expr);
            continue;
        }

        if (token.type === "operator") {
            while (operator.length > 0) {
                const op = operator[operator.length - 1];
                if (getOperatorPrecedence(op.value) >= getOperatorPrecedence(token.value)) {
                    const arg2 = output.pop()!;
                    const arg1 = output.pop()!;
                    output.push({
                        kind: "binary-expression",
                        calleeLabel: operator.pop()!.value,
                        arguments: [arg1, arg2]
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
            output.push(parseExpression(tokens, scope));
            tokens.shift();
            continue;
        }

        // Non-consumed terminators
        if (isInTuple(token.type, ["}", ")", ","])) break;

        throw new Error(`Unexpected token: ${token.type} ${token.value}`);
    }

    // Infix parsing
    while (operator.length > 0) {
        const arg2 = output.pop()!;
        const arg1 = output.pop()!;
        output.push({
            kind: "binary-expression",
            calleeLabel: operator.pop()!.value,
            arguments: [arg1, arg2]
        });
    }

    return output[0] as Instruction;
}

function parseIfExpression(tokens: Token[], output: Instruction[], scope: Scope) {
    // Get rid of the if token
    tokens.shift();

    const condition = parseExpression(tokens, scope, { type: "{", value: "{" });
    const ifScope = scope.sub();
    const body = parseTokens(tokens, ifScope);
    let elseVal: undefined | { body: Instruction[], scope: Scope } = undefined;
    const elifs: { condition: ASTNode, body: Instruction[], scope: Scope }[] = [];

    let next = tokens[0];
    while (next) {
        if (next.type === "keyword" && next.value === "else") {
            tokens.shift();
            const elseScope = scope.sub();
            elseVal = { body: parseTokens(tokens, elseScope), scope: elseScope };
            break;
        }

        if (next.type === "keyword" && next.value === "elif") {
            tokens.shift();
            const elifScope = scope.sub();
            const condition = parseExpression(tokens, scope, { type: "{", value: "{" });
            const body = parseTokens(tokens, elifScope);
            elifs.push({ condition, body, scope: elifScope });
            next = tokens[0];
            continue;
        }

        break;
    }

    output.push({ kind: "if-expression", condition, body, elifs, else: elseVal, scope: ifScope });
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

/**
 * Starting with an identifier token. Can break down property access expressions.
 * Simplified form of shunting yard.
 * @param tokens
 */
function parseIdentifierExpression(tokens: Token[]): PropertyAccessExpression | Identifier {
    const identifiers: (PropertyAccessExpression | Identifier)[] = [];
    const operators: string[] = [];

    while (tokens[0]) {
        if (tokens[0].type === "identifier") {
            identifiers.push({ kind: "identifier", label: tokens.shift()!.value });
            continue;
        }

        if (tokens[0].value === ".") {
            while (operators.length > 0) {
                operators.pop();
                const arg2 = identifiers.pop()!;
                const arg1 = identifiers.pop()!;
                identifiers.push({
                    kind: "property-access-expression",
                    arguments: [arg1, arg2]
                });
            }

            operators.push(tokens.shift()!.value);
            continue;
        }

        break;
    }

    let output: PropertyAccessExpression | Identifier = identifiers.pop()!;

    if (operators.length > 0) {
        const arg2: PropertyAccessExpression | Identifier = output;
        const arg1 = identifiers.pop()!;
        output = {
            kind: "property-access-expression",
            arguments: [arg1, arg2]
        };
    }

    return output;
}

function parseArguments(tokens: Token[], scope: Scope): Instruction[] {
    const args: Instruction[] = [];

    // For now we just get rid of the opening brace. We also only handle (
    const openingBracket = tokens.shift();
    if (!openingBracket || openingBracket.type !== "(") {
        throw new Error("Expected opening bracket in argument expression");
    }

    while (tokens.length > 0) {
        let token = tokens[0];
        if (token.type === ",") {
            tokens.shift();
        }

        if (token.type === ")") {
            tokens.shift();
            break;
        }

        args.push(parseExpression(tokens, scope))
        token = tokens[0];
    }

    return args;
}

/** Parse a block beginning with the initial opening curly brace ({) */
function parseBlockExpression(tokens: Token[], flags: string[], scope: Scope): BlockExpression {
    const blockScope = scope.sub();
    return {
        kind: "block-expression",
        flags,
        scope: blockScope,
        body: parseTokens(tokens, blockScope)
    }
}

function parseImplDeclaration(tokens: Token[], flags: string[], scope: Scope): ImplDeclaration {
    const { target, trait } = extractTargetAndTraitFromImplSignature(tokens);
    const functions: FunctionDeclaration[] = [];
    const implScope = scope.sub();

    // Get rid of the opening {
    tokens.shift();

    let next = tokens[0];
    while (next) {
        if (next.type === "}") {
            tokens.shift();
            break;
        };

        if (next.type === "\n") {
            tokens.shift();
            next = tokens[0];
            continue;
        }

        if (next.type !== "keyword") {
            console.dir(next);
            throw new Error("Unexpected token in impl block.");
        }

        const statement = parseKeywordStatement(tokens, implScope);

        // Only functions are allowed in impls for now.
        if (statement.kind !== "function-declaration") {
            console.dir(statement);
            throw new Error("Unexpected statement in impl.")
        }

        functions.push(statement);
        next = tokens[0];
    }

    return {
        kind: "impl-declaration",
        flags,
        trait,
        target,
        functions,
        scope: implScope
    }
}

function extractTargetAndTraitFromImplSignature(tokens: Token[]) {
    const label1 = tokens.shift();
    assertIdentifer(label1);
    const next = tokens[0];
    if (next && next.type === "keyword" && next.value === "for") {
        tokens.shift();
        const label2 = tokens.shift();
        assertIdentifer(label2);
        return { target: label2.value, trait: label1.value };
    }
    return { target: label1.value, trait: undefined };
}

function parseTypeDeclaration(tokens: Token[], flags: string[], scope: Scope): TypeDeclaration {
    let labelToken = tokens.shift();
    if (!labelToken || labelToken.type !== "identifier") {
        throw new Error("Expected identifier for type declaration");
    }

    return {
        kind: "type-declaration",
        label: labelToken.value,
        flags,
        scope: scope.sub()
    }
}

/** Parse an enum, beginning after enum */
function parseEnumDeclaration(tokens: Token[], flags: string[], scope: Scope): EnumDeclaration {
    const identifierToken = tokens.shift();
    if (!identifierToken || identifierToken.type !== "identifier") {
        throw new Error("Expected identifier after enum declaration");
    }

    const label = identifierToken.value;

    if (tokens[0].type !== "{") {
        throw new Error(`Unexpected token in enum declaration: ${tokens[0].type}`);
    }
    tokens.shift();

    const variants = parseEnumVariants(tokens, label);

    return {
        kind: "enum-declaration",
        label,
        flags,
        variants,
        typeParameters: [],
        scope: scope.sub()
    }
}

function parseEnumVariants(tokens: Token[], parentEnum: string): EnumVariantDeclaration[] {
    const variants: EnumVariantDeclaration[] = [];

    while (tokens[0]) {
        const token = tokens[0];
        if (token.type === "identifier") {
            variants.push({
                kind: "enum-variant",
                label: token.value,
                parentEnum,
                flags: []
            });
            tokens.shift();
            continue;
        }

        if (token.type === "," || token.type === "\n") {
            tokens.shift();
            continue;
        }

        if (token.type === "}") {
            tokens.shift();
            break;
        }

        throw new Error(`Unexpected token in enum: ${token.value}`);
    }

    return variants;
}

function parseMatchCases(tokens: Token[], scope: Scope): MatchCase[] {
    const variants: MatchCase[] = [];

    while (tokens[0]) {
        const token = tokens[0];

        if (token.type === "}") {
            tokens.shift();
            break;
        }

        if (token.type === "\n") {
            tokens.shift();
            continue;
        }

        const matchCase = parseExpression(tokens, scope, { type: "=>", value: "=>" });
        const expression = parseExpression(tokens, scope, { type: ",", value: "," });

        variants.push({
            kind: "match-case",
            case: matchCase,
            expression
        });
    }

    return variants;
}

function assertIdentifer(token: any): asserts token is { type: "identifier", value: string } {
    if (!token || token.type !== "identifier") {
        throw new Error("Expected identifier");
    }
}
