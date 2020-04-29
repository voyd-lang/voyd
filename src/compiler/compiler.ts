import binaryen from "binaryen";
import { Instruction, MethodOrFunctionCall, ReturnStatement, IfExpression, Assignment, MethodDeclaration, VariableDeclaration, WhileStatement } from "../parser/definitions";
import { Values } from "./values";
import { MethodValue } from "./definitions";
import { parse } from "../parser";

export function compile(code: string) {
    const ast = parse(code);
    const mod = new binaryen.Module();
    const ids = new Values();
    mod.autoDrop();
    mod.addFunctionImport("print", "imports", "print", binaryen.i32, binaryen.none);
    mod.addFunction("main", binaryen.none, binaryen.none, [], compileBlock({
        body: ast, mod, vals: ids, returnType: binaryen.none
    }));
    mod.addFunctionExport("main", "main");
    return mod;
}

function compileBlock({ body, mod, vals, returnType, existingInstructions, additionalInstructions }: {
    body: Instruction[],
    mod: binaryen.Module,
    vals: Values,
    returnType?: number,
    existingInstructions?: number[],
    additionalInstructions?: number[],
}): number {
    const block: number[] = existingInstructions ?? [];

    body.forEach(instruction => {
        if (instruction.kind === "variable-declaration") {
            compileVariableDeclaration(instruction, vals, mod, block);
            return;
        }

        if (instruction.kind === "method-declaration") {
            compileMethodDeclaration(instruction, vals, mod);
            return;
        }

        if (instruction.kind === "assignment") {
            compileAssignment(instruction, mod, vals, block);
            return;
        }

        // TODO: make this an expression
        if (instruction.kind === "if-expression") {
            compileIfExpression(block, mod, instruction, vals);
            return;
        }

        if (instruction.kind === "while-statement") {
            compileWhileStatement(block, mod, instruction, vals);
            return;
        }

        if (instruction.kind === "return-statement") {
            compileReturn(block, mod, instruction, vals);
            return;
        }

        block.push(compileExpression(instruction, mod, vals));
    });

    if (additionalInstructions) block.push(...additionalInstructions);
    return mod.block("", block, returnType);
}

function compileReturn(block: number[], mod: binaryen.Module, instruction: ReturnStatement, vals: Values) {
    block.push(mod.return(compileExpression(instruction.expression, mod, vals)));
}

function compileIfExpression(block: number[], mod: binaryen.Module, instruction: IfExpression, vals: Values) {
    block.push(
        mod.if(compileExpression(instruction.condition, mod, vals),
            compileBlock({ body: instruction.body, mod, vals: vals }))
    );
}

function compileWhileStatement(block: number[], mod: binaryen.Module, instruction: WhileStatement, vals: Values) {
    block.push(
        mod.block("while", [
            mod.loop("loop",
                compileBlock({
                    body: instruction.body, mod, vals: vals,
                    existingInstructions: [
                        mod.br("while", mod.i32.ne(
                            compileExpression(instruction.condition, mod, vals),
                            mod.i32.const(1)
                        ))
                    ],
                    additionalInstructions: [
                        mod.br("loop")
                    ]
                })
            )
        ])
    );
}

function compileAssignment(instruction: Assignment, mod: binaryen.Module, vals: Values, block: number[]) {
    const id = instruction.identifier;
    const expr = compileExpression(instruction.expression, mod, vals);
    block.push(mod.global.set(id, expr));
}

function compileMethodDeclaration(instruction: MethodDeclaration, vals: Values, mod: binaryen.Module) {
    const id = instruction.identifier;
    const internalVals = vals.clone();
    const params = instruction.parameters.map((param, index) => {
        const type = getTypeFromString(param.type!.identifier);
        internalVals.register({
            kind: "local",
            mutable: false,
            type, flags: [],
            identifier: param.identifier,
            index
        });
        return type;
    });
    const returnType = getTypeFromString(instruction.returnType!.identifier);
    const method: MethodValue = {
        kind: "method",
        identifier: id,
        typeParameters: [],
        parameterTypes: params,
        returnType: instruction.returnType!.identifier,
        flags: instruction.flags ?? []
    };
    internalVals.register(method);
    vals.register(method);

    const methodBody = compileBlock({
        body: instruction.body,
        mod,
        vals: internalVals,
        returnType
    });

    mod.addFunction(id, binaryen.createType(params), returnType, [], methodBody);
}

function compileVariableDeclaration(instruction: VariableDeclaration, ids: Values, mod: binaryen.Module, block: number[]) {
    const id = instruction.identifiers[0];
    const type = instruction.type ?
        getTypeFromString(instruction.type.identifier) :
        inferType(instruction.initializer!, ids);
    mod.addGlobal(id, type, true, globalInit(type, mod));
    ids.register({
        kind: "global",
        identifier: id,
        type,
        mutable: instruction.flags.includes("var"),
        flags: instruction.flags
    });
    if (instruction.initializer) {
        block.push(mod.global.set(id, compileExpression(instruction.initializer, mod, ids)));
    }
}

function compileExpression(expr: Instruction, mod: binaryen.Module, ids: Values): number {
    if (expr.kind === "i32-literal") {
        return mod.i32.const(Number(expr.value));
    }

    if (expr.kind === "f32-literal") {
        return mod.f32.const(Number(expr.value));
    }

    if (expr.kind === "bool-literal") {
        return mod.i32.const(expr.value ? 1 : 0);
    }

    if (expr.kind === "identifier") {
        const identifier = ids.retrieve(expr.value);

        if (identifier.kind === "local") {
            return mod.local.get(identifier.index, identifier.type);
        }

        if (identifier.kind === "global") {
            return mod.global.get(identifier.identifier, identifier.type);
        }

        throw new Error(`Unsupported identifier type in expression: ${identifier.kind}`);
    }

    if (expr.kind === "method-or-function-call") {
        if (["+", "-", "*", "/", "<", ">", ">=", "<="].includes(expr.identifier)) {
            return compileBinaryExpression(expr, mod, ids);
        }

        if (expr.identifier === "print") {
            return (mod.call as any)("print", [compileExpression(expr.arguments[0], mod, ids)], binaryen.none);
        }

        const id = ids.retrieve(expr.identifier);
        if (id.kind !== "method") throw new Error(`${expr.identifier} is not a method`);
        const args = expr.arguments.map(instr => compileExpression(instr, mod, ids));
        return (mod.call as any)(id.identifier, args, getTypeFromString(id.returnType));
    }

    throw new Error(`Invalid expression ${expr.kind}`);
}

function compileBinaryExpression(expr: MethodOrFunctionCall, mod: binaryen.Module, ids: Values): number {
    const arg1 = expr.arguments.pop()!;
    const arg2 = expr.arguments.pop()!;
    const type = inferType(arg1, ids); // Probably room for performance improvements here.
    const cArg1 = compileExpression(arg1, mod, ids);
    const cArg2 = compileExpression(arg2, mod, ids);
    const id = expr.identifier;

    if (type === binaryen.i32 && id === "+") {
        return mod.i32.add(cArg1, cArg2)
    }

    if (type === binaryen.f32 && id === "+") {
        return mod.f32.add(cArg1, cArg2)
    }

    if (type === binaryen.i32 && id === "-") {
        return mod.i32.sub(cArg1, cArg2)
    }

    if (type === binaryen.f32 && id === "-") {
        return mod.f32.sub(cArg1, cArg2)
    }

    if (type === binaryen.i32 && id === "*") {
        return mod.i32.mul(cArg1, cArg2)
    }

    if (type === binaryen.f32 && id === "*") {
        return mod.f32.mul(cArg1, cArg2)
    }

    if (type === binaryen.i32 && id === "/") {
        return mod.i32.div_s(cArg1, cArg2)
    }

    if (type === binaryen.f32 && id === "/") {
        return mod.f32.div(cArg1, cArg2)
    }

    if (type === binaryen.i32 && id === "<") {
        return mod.i32.lt_s(cArg1, cArg2)
    }

    if (type === binaryen.i32 && id === ">") {
        return mod.i32.gt_s(cArg1, cArg2)
    }

    if (type === binaryen.i32 && id === "<=") {
        return mod.i32.le_s(cArg1, cArg2)
    }

    if (type === binaryen.i32 && id === ">=") {
        return mod.i32.ge_s(cArg1, cArg2)
    }

    if (type === binaryen.f32 && id === "<") {
        return mod.f32.lt(cArg1, cArg2)
    }

    if (type === binaryen.f32 && id === ">") {
        return mod.f32.gt(cArg1, cArg2)
    }

    if (type === binaryen.f32 && id === "<=") {
        return mod.f32.le(cArg1, cArg2)
    }

    if (type === binaryen.f32 && id === ">=") {
        return mod.f32.ge(cArg1, cArg2)
    }

    throw new Error(`Unsupported add type: ${type}`);
}

function inferType(expression: Instruction, ids: Values): number {
    if (expression.kind === "method-or-function-call") {
        if (["+", "-", "*", "/"].includes(expression.identifier)) {
            return inferType(expression.arguments[0], ids);
        }

        if (["==", ">", "<", ">=", "<=", "and", "ir"].includes(expression.identifier)) {
            return binaryen.i32;
        }

        const identifier = ids.retrieve(expression.identifier);
        if (identifier.kind !== "method" || !identifier.returnType) {
            throw new Error(`Unable to infer return type for ${expression.identifier}`);
        }
        return getTypeFromString(identifier.returnType);
    }

    if (expression.kind === "bool-literal") return binaryen.i32;
    if (expression.kind === "f32-literal") return binaryen.f32;
    if (expression.kind === "i32-literal") return binaryen.i32;
    if (expression.kind === "return-statement") return inferType(expression.expression, ids);
    if (expression.kind === "if-expression") {
        return inferType(expression.body[expression.body.length - 1], ids);
    }

    if (expression.kind === "identifier") {
        const id = ids.retrieve(expression.value);
        if (id.kind === "method") throw new Error("Unexpected identifier");
        return id.type;
    }


    throw new Error(`Unable to infer type for ${expression.kind}`);
}

function globalInit(type: number, mod: binaryen.Module): number {
    switch (type) {
        case binaryen.i32:
            return mod.i32.const(0);
        case binaryen.i64:
            return mod.i64.const(0, 0);
        case binaryen.f32:
            return mod.f32.const(0);
        case binaryen.f64:
            return mod.f64.const(0);
        default:
            throw new Error(`Unknown type: ${type}`);
    }
}

function getTypeFromString(typeIdentifier: string): number {
    if (typeIdentifier === "i32") return binaryen.i32;
    if (typeIdentifier === "f32") return binaryen.f32;
    if (typeIdentifier === "i64") return binaryen.i64;
    if (typeIdentifier === "f64") return binaryen.f64;
    throw new Error(`Unknown type: ${typeIdentifier}`);
}

function getMutability(flags: string[]): boolean {
    if (flags.includes("let")) return false;
    if (flags.includes("var")) return true;
    throw new Error("Passed flags do not include mutability modifiers");
}
