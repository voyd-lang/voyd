import { Token, tokenize, TokenType } from "../lexer";
import { isInTuple } from "../helpers";
import { Assignment, BinaryExpression, Block, BoolLiteral, Break, Call, ContainerNode, Continue, ExpressionNode, FloatLiteral, FunctionNode, Identifier, If, Impl, IntLiteral, Parameter, PropertyAccess, Return, StatementNode, StringLiteral, StructLiteral, Use, UseTree, Variable, While, TypeAlias, Enum, EnumVariant, Module, WasmType, TypeNode } from "../ast";

export function parse({ code, name, parent }: {
    code: string,
    name: string,
    parent?: ContainerNode
}): Module {
    const tokens = tokenize(code);
    const module = new Module({ name, parent });
    if (parent) parent.pushChild(module);
    parseBody(tokens, module);
    return module;
}

/** Parse a body. Will stop at "}" characters and remove them. */
function parseBody(tokens: Token[], container: ContainerNode) {
    while (tokens.length > 0) {
        const next = tokens[0];
        if (next.type === "}") {
            tokens.shift();
            break;
        }

        container.pushChild(parseStatement(tokens, container));
    }
}

function parseStatement(tokens: Token[], container: ContainerNode): StatementNode {
    while (tokens.length > 0) {
        const token = tokens[0];

        if (token.type === "keyword") {
            return parseKeywordStatement(tokens, container);
        }

        return parseExpression(tokens, container);
    }

    throw new Error("Invalid statement");
}

function parseKeywordStatement(tokens: Token[], container: ContainerNode): StatementNode {
    let token = tokens[0];

    if (token.value === "return") {
        return parseReturnStatement(tokens, container);
    }

    if (["if", "while", "for", "match"].includes(token.value)) {
        return parseExpression(tokens, container);
    }

    if (token.value === "continue") {
        return new Continue(container);
    }

    if (token.value === "break") {
        return new Break(container);
    }

    const flags: string[] = [];
    while (token.type === "keyword") {
        flags.push(shift(tokens).value);
        token = tokens[0];
    }

    if (flags.includes("use")) {
        return parseUseStatement(tokens, flags, container);
    }

    if (flags.some(val => val === "let" || val === "var")) {
        return parseVariableDeclaration(tokens, flags, container);
    }

    if (flags.includes("fn")) {
        return parseFnDeclaration(tokens, flags, container);
    }

    if (flags.includes("enum")) {
        return parseEnumDeclaration(tokens, flags, container);
    }

    if (flags.includes("type")) {
        return parseTypeDeclaration(tokens, flags, container);
    }

    if (flags.includes("unsafe")) {
        return parseBlock(tokens, flags, container);
    }

    if (flags.includes("impl")) {
        return parseImpl(tokens, flags, container);
    }

    const keywordStr = flags.reduce((p, c) => `${p} ${c}`, "");
    throw new Error(`Expected statement after keyword(s):${keywordStr}`);
}

function parseUseStatement(tokens: Token[], flags: string[], container: ContainerNode): StatementNode {
    return new Use({
        parent: container,
        flags,
        tree: parseUseTree(tokens, container)
    });
}

function parseUseTree(tokens: Token[], container: ContainerNode): UseTree {
    const tree: UseTree = { path: [], node: { kind: "self" } };

    while (tokens[0]) {
        const token = tokens[0];
        const next = tokens[1];

        if (token.type === "identifier" && next && next.value === ".") {
            tokens.shift();
            tokens.shift();
            tree.path.push(new Identifier({ name: token.value, tokenIndex: token.index, parent: container }));
            continue;
        }

        if (token.type === "identifier" && next && next.value === ",") {
            tokens.shift();
            tokens.shift();
            tree.path.push(new Identifier({ name: token.value, tokenIndex: token.index, parent: container }));
            break;
        }

        if (token.type === "identifier") {
            tokens.shift();
            tree.path.push(new Identifier({ name: token.value, tokenIndex: token.index, parent: container }));
            break;
        }

        if (token.value === "*") {
            tokens.shift();
            tree.node = { kind: "wildcard" };
            break;
        }

        if (token.value === ",") {
            tokens.shift();
            break;
        }

        if (token.value === "]") {
            // Do not get rid of "]" so branch parsing knows when to stop
            break;
        }

        if (token.value === "[") {
            tokens.shift();
            tree.node = { kind: "branched", branches: [] };
            while (tokens[0] && tokens[0].value !== "]") {
                tree.node.branches.push(parseUseTree(tokens, container));
            }

            // Get rid of "]"
            tokens.shift();
        }
    }

    return tree;
}

function parseReturnStatement(tokens: Token[], parent: ContainerNode): Return {
    const returnToken = tokens.shift();
    if (!returnToken || returnToken.value !== "return") {
        throw new Error("Expected return token");
    }

    return new Return({ parent, expression: parseExpression(tokens, parent) });
}

/** Parse a function, beginning after fn */
function parseFnDeclaration(tokens: Token[], flags: string[], container: ContainerNode): FunctionNode {
    const nameToken = tokens.shift();
    if (!nameToken || nameToken.type !== "identifier" && nameToken.type !== "operator") {
        throw new Error("Expected identifier after function declaration");
    }
    const name = nameToken.value;

    // We don't pass fn scope here because the scope is used for a possible parameter initializer.
    const parameters = parseFnParameters(tokens, container);

    let returnTypeName: string | undefined;
    if (tokens[0].type === "->") {
        tokens.shift();
        returnTypeName = parseTypeArgument(tokens);
    }

    const fn = new FunctionNode({ name, parent: container, flags, returnTypeName, parameters })

    if (flags.includes("declare")) {
        // Do nothing
    } else if (tokens[0].type === "{") {
        fn.expression = parseExpression(tokens, fn);
    } else if (tokens[0].type === "operator" && tokens[0].value === "=") {
        tokens.shift();
        fn.expression = parseExpression(tokens, fn);
    } else {
        throw new Error(`Unexpected token in function declaration: ${tokens[0].type}`);
    }

    return fn;
}

function parseFnParameters(tokens: Token[], container: ContainerNode): Parameter[] {
    const params: Parameter[] = [];

    const openingBracket = tokens.shift();
    if (!openingBracket || !isInTuple(openingBracket.type, <const>["("])) {
        throw new Error("Function definition missing parameters");
    }

    // In the future, we will support "]" as well
    const closeBracket = <const>")";

    let token = tokens[0];
    while (token && token.type !== closeBracket) {
        if (token.type === "identifier") {
            params.push(parseParameter(tokens, params.length, container));
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

function parseParameter(tokens: Token[], localIndex: number, container: ContainerNode): Parameter {
    const flags: string[] = [];

    const identifierToken = tokens.shift();
    if (!identifierToken || identifierToken.type !== "identifier") {
        throw new Error("Invalid parameter definition");
    }

    const name = identifierToken.value;

    const separator = tokens.shift();
    if (!separator || !isInTuple(separator.value, <const>[":", "="])) {
        throw new Error("Unexpected token in parameter definition");
    }

    if (separator.value === "=") {
        const initializer = parseExpression(tokens, container);
        return new Parameter({ name, localIndex, initializer, parent: container, flags });
    }

    let token = tokens[0];
    while (token && isInTuple(token.value, <const>["mut", "ref"])) {
        flags.push(token.value);
        tokens.shift();
        token = tokens[0];
    }

    const typeName = parseTypeArgument(tokens);

    return new Parameter({ name, localIndex, parent: container, flags, typeName });
}

function parseVariableDeclaration(tokens: Token[], flags: string[], parent: ContainerNode): Variable {
    let typeName: string | undefined = undefined;
    let initializer: ExpressionNode | undefined;

    const nameToken = tokens.shift();
    if (!nameToken || nameToken.type !== "identifier") {
        throw new Error("Identifier expected");
    }

    if (tokens[0].type === ":") {
        tokens.shift();
        typeName = parseTypeArgument(tokens);
    }

    if (tokens[0].value === "=") {
        tokens.shift();
        initializer = parseExpression(tokens, parent);
    }

    return new Variable({
        name: nameToken.value, tokenIndex: nameToken.index, initializer, typeName, flags,
        parent
    });
}

function parseTypeArgument(tokens: Token[]): string {
    return shift(tokens).value;
}

function parseExpression(tokens: Token[], parent: ContainerNode, terminator?: TokenType, flags: string[] = []): ExpressionNode {
    const output: ExpressionNode[] = [];
    const operator: Token[] = [];

    // Since we don't use ; to terminate an expression, we can tell the expression
    // Is done if we get two non-operator tokens in a row (-newlines).
    // This is my ugly temp solution. Looking for a way to make it cleaner.
    let expectOperatorToContinue = false;
    while (tokens.length > 0) {
        const token = tokens[0];

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
            output.push(parseBlock(tokens, flags, parent));
            continue;
        }

        if (token.type === "[") {
            output.push(parseStructLiteral(tokens, flags, parent));
            continue;
        }

        if (token.type === "int") {
            output.push(new IntLiteral({ parent, value: token.value }));
            tokens.shift();
            continue;
        }

        if (token.type === "float") {
            output.push(new FloatLiteral({ parent, value: token.value }));
            tokens.shift();
            continue;
        }

        if (token.type === "string") {
            output.push(new StringLiteral({ parent, value: token.value }));
            tokens.shift();
            continue;
        }

        if (token.type === "boolean") {
            output.push(new BoolLiteral({ parent, value: token.value }));
            tokens.shift();
            continue;
        }

        if (token.type === "keyword") {
            if (token.value === "if") {
                output.push(parseIfExpression(tokens, parent));
                continue;
            }

            if (token.value === "while") {
                tokens.shift();
                const condition = parseExpression(tokens, parent, "{");
                const block = parseBlock(tokens, [], parent);
                output.push(new While({ parent, condition, block }));
                continue;
            }

            if (token.value === "match") {
                throw new Error("Match not yet implemented.");
                continue;
            }

            if (token.value === "unsafe") {
                tokens.shift();
                output.push(parseExpression(tokens, parent, undefined, ["unsafe"]));
                continue;
            }

            throw new Error(`Invalid keyword in expression: ${token.value}`);
        }

        if (token.type === "identifier") {
            tokens.shift();
            const label = token.value;

            // Handle possible function / method call
            const next = tokens[0];
            if (next && isInTuple(next.type, ["(", "["])) {
                output.push(new Call({
                    parent, calleeName: label, arguments: parseArguments(tokens, parent)
                }));
                continue;
            }

            output.push(new Identifier({ name: label, tokenIndex: token.index, parent }));
            continue;
        }

        if (token.type === "operator") {
            while (operator.length > 0) {
                const op = operator[operator.length - 1];
                const hasHigherPrecedence =
                    getOperatorPrecedence(op.value) >= getOperatorPrecedence(token.value);
                if (!hasHigherPrecedence) break;
                output.push(buildBinaryExpression(output, operator, parent));
            }

            operator.push(shift(tokens));
            continue;
        }

        if (token.type === "(") {
            tokens.shift();
            output.push(parseExpression(tokens, parent));
            tokens.shift();
            continue;
        }

        // Non-consumed terminators
        if (token.type === terminator || isInTuple(token.type, ["}", ")", ","])) break;

        throw new Error(`Unexpected token: ${token.type} ${token.value}`);
    }

    // Infix parsing
    while (operator.length > 0) {
        output.push(buildBinaryExpression(output, operator, parent));
    }

    return output[0] as ExpressionNode;
}

function buildBinaryExpression(output: ExpressionNode[], operators: Token[], parent: ContainerNode): ExpressionNode {
    const arg2 = pop(output);
    const arg1 = pop(output);
    const label = pop(operators).value;

    if (label === ".") {
        return new PropertyAccess({ left: arg1, right: arg2, parent })
    }

    if (label === "=") {
        if (!(arg1 instanceof PropertyAccess) && !(arg1 instanceof Identifier)) {
            throw new Error("Invalid expression on left side of assignment.");
        }

        return new Assignment({ assignee: arg1, expression: arg2, parent });
    }

    return new BinaryExpression({ parent, arguments: [arg1, arg2], calleeName: label });
}

function parseIfExpression(tokens: Token[], parent: ContainerNode): If {
    // Get rid of the if token
    tokens.shift();

    const ifNode = new If({
        parent,
        condition: parseExpression(tokens, parent, "{"),
        block: parseBlock(tokens, [], parent)
    })

    let next = tokens[0];
    while (next) {
        if (next.type === "keyword" && next.value === "else") {
            tokens.shift();
            ifNode.elseBlock = parseBlock(tokens, [], parent);
            break;
        }

        if (next.type === "keyword" && next.value === "elif") {
            tokens.shift();
            const condition = parseExpression(tokens, parent, "{");
            ifNode.pushElif({ condition, block: parseBlock(tokens, [], parent) });
            next = tokens[0];
            continue;
        }

        break;
    }

    return ifNode;
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

function parseArguments(tokens: Token[], parent: ContainerNode): ExpressionNode[] {
    const args: ExpressionNode[] = [];

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

        args.push(parseExpression(tokens, parent))
        token = tokens[0];
    }

    return args;
}

/** Parse a block beginning with the initial opening curly brace ({) */
function parseBlock(tokens: Token[], flags: string[], parent: ContainerNode): Block {
    const block = new Block(parent, flags);

    if (!tokens[0] || tokens[0].type !== "{") {
        throw new Error("parseBlock called without a block start");
    }

    // Get rid of opening {
    tokens.shift();

    while (tokens.length > 0) {
        const next = tokens[0];
        if (next.type === "}") {
            tokens.shift();
            break;
        }

        block.pushChild(parseStatement(tokens, block));
    }

    return block;
}

function parseStructLiteral(tokens: Token[], flags: string[], parent: ContainerNode): StructLiteral {
    // For now we just get rid of the opening brace. We also only handle [
    const openingBracket = tokens.shift();
    if (!openingBracket || openingBracket.type !== "[") {
        throw new Error("Expected opening bracket in struct instance");
    }

    const struct = new StructLiteral({ flags, parent })

    while (tokens.length > 0) {
        const token = tokens[0];
        const nextTokenType = tokens[1] ? tokens[1].type : undefined;

        if (token.type === "]") {
            tokens.shift();
            break;
        }

        if (token.type === ",") {
            tokens.shift();
            continue;
        }

        if (token.type === "identifier" && nextTokenType === ":") {
            const name = token.value;
            tokens.shift();
            tokens.shift();
            struct.addField({ name, initializer: parseExpression(tokens, parent, ","), flags: [] });
            continue;
        }

        if (token.type === "identifier" && nextTokenType === ",") {
            const name = token.value;
            tokens.shift();
            tokens.shift();
            struct.addField({
                name, flags: [],
                initializer: new Identifier({ name, tokenIndex: token.index, parent })
            });
            continue;
        }

        if (token.type === "identifier" && nextTokenType === "]") {
            const name = token.value;
            tokens.shift();
            tokens.shift();
            struct.addField({
                name, flags: [],
                initializer: new Identifier({ name, tokenIndex: token.index, parent })
            });
            break;
        }

        throw new Error(`Unexpected token: ${token.value}`);
    }

    return struct;
}

function parseImpl(tokens: Token[], flags: string[], parent: ContainerNode): Impl {
    const { target, trait } = extractTargetAndTraitFromImplSignature(tokens);
    const impl = new Impl({ targetName: target, parent, flags, traitName: trait });

    // Get rid of the opening {
    tokens.shift();

    let next = tokens[0];
    while (next) {
        if (next.type === "}") {
            tokens.shift();
            break;
        }

        if (next.type !== "keyword") {
            throw new Error("Unexpected token in impl block.");
        }

        const statement = parseKeywordStatement(tokens, impl);

        // Only functions are allowed in impls for now.
        if (!(statement instanceof FunctionNode)) {
            console.dir(statement);
            throw new Error("Unexpected statement in impl.")
        }

        impl.pushFn(statement);
        next = tokens[0];
    }

    impl.functions.forEach(fn => fn.addThisParameter(target, impl));

    return impl;
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

function parseTypeDeclaration(tokens: Token[], flags: string[], parent: ContainerNode): TypeNode {
    const nameToken = tokens.shift();
    if (!nameToken || nameToken.type !== "identifier") {
        throw new Error("Expected identifier for type declaration");
    }
    const name = nameToken.value;

    if (flags.includes("declare")) {
        return new TypeAlias({ name, flags, parent });
    }

    const equals = tokens.shift();
    if (!equals) throw new Error("Expected =");
    if (equals.value !== "=") throw new Error(`Unexpected token ${equals.type}`);

    const type = tokens.shift();
    if (!type) throw new Error(`Expected type after type declaration ${name}`);

    if (type.type === "keyword" && type.value === "wasm_type") {
        return parseWasmType({ tokens, flags, parent, name });
    }

    throw new Error(`Unknown type in type declaration ${name}`);
}

function parseWasmType({ tokens, flags, parent, name }: {
    tokens: Token[]; flags: string[]; parent: ContainerNode;
    name: string;
}) {
    const typeInfo = parseStructLiteral(tokens, [], parent);
    const { id, size } = typeInfo.fields;

    if (!id) throw new Error(`Missing wasm type id for ${name}`);
    if (!size) throw new Error(`Missing wasm type size for ${name}`);

    if (!(id.initializer instanceof StringLiteral)) {
        throw new Error(`Invalid id for wasm type ${name}, expected string literal.`);
    }

    if (!(size.initializer instanceof IntLiteral)) {
        throw new Error(`Invalid size for wasm type ${name}, expected int literal.`);
    }

    return new WasmType({
        name, wasmTypeId: id.initializer.value, size: size.initializer.value, flags,
        parent
    });
}

/** Parse an enum, beginning after enum */
function parseEnumDeclaration(tokens: Token[], flags: string[], parent: ContainerNode): Enum {
    const identifierToken = tokens.shift();
    if (!identifierToken || identifierToken.type !== "identifier") {
        throw new Error("Expected identifier after enum declaration");
    }

    const name = identifierToken.value;

    if (tokens[0].type !== "{") {
        throw new Error(`Unexpected token in enum declaration: ${tokens[0].type}`);
    }
    tokens.shift();

    const enumNode = new Enum({ name, flags, parent });
    const variants = parseEnumVariants(tokens, enumNode);
    enumNode.pushVariant(...variants);

    return enumNode;
}

function parseEnumVariants(tokens: Token[], parent: Enum): EnumVariant[] {
    const variants: EnumVariant[] = [];

    while (tokens[0]) {
        const token = tokens[0];
        if (token.type === "identifier") {
            variants.push(new EnumVariant({
                parent, name: token.value, flags: [], num: variants.length
            }));
            tokens.shift();
            continue;
        }

        if (token.type === ",") {
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

function shift(tokens: Token[]): Token {
    const token = tokens.shift();
    if (!token) throw new Error("Missing expected token.");
    return token;
}

function pop<T>(array: T[]): T {
    const item = array.pop();
    if (!item) throw new Error("Missing expected item in array.");
    return item;
}

function assertIdentifer(token?: Token): asserts token is { type: "identifier", value: string, index: number } {
    if (!token || token.type !== "identifier") {
        throw new Error("Expected identifier");
    }
}
