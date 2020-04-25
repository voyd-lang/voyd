import binaryen from "binaryen";
import { Instruction, MethodOrFunctionCall } from "../parser/definitions";
import { IdentifiersCollection } from "./identifiers";

export function compile(ast: Instruction[]) {
    const mod = new binaryen.Module();
    const ids = new IdentifiersCollection();
    mod.autoDrop();
    mod.addFunctionImport("print", "imports", "print", binaryen.i32, binaryen.none);
    mod.addFunction("main", binaryen.none, binaryen.none, [], compileBlock({
        body: ast, mod, ids, returnType: binaryen.none
    }));
    mod.addFunctionExport("main", "main");
    return mod;
}

function compileBlock({ body, mod, ids, returnType }: {
    body: Instruction[],
    mod: binaryen.Module,
    ids: IdentifiersCollection,
    returnType?: number
}): number {
    const block: number[] = [];

    body.forEach(instruction => {
        if (instruction.kind === "variable-declaration") {
            const id = instruction.identifiers[0];
            const type = instruction.type ?
                getTypeFromString(instruction.type.identifier) :
                inferType(instruction.initializer!, ids);

            mod.addGlobal(id, type, true, globalInit(type, mod));

            if (instruction.initializer) {
                block.push(
                    mod.global.set(
                        id,
                        compileExpression(instruction.initializer, mod, ids)
                    )
                );
            }
        }

        if (instruction.kind === "method-declaration") {
            const id = instruction.identifier;
            const params = instruction.parameters.map(param => {
                return getTypeFromString(param.type!.identifier);
            });
            const methodReturnType = getTypeFromString(instruction.returnType!.identifier);
            const methodBody = compileBlock({
                body: instruction.body, mod, ids, returnType: methodReturnType
            });
            mod.addFunction(id, binaryen.createType(params), methodReturnType, [], methodBody);
        }

        if (instruction.kind === "assignment") {
            const id = instruction.identifier;
            const expr = compileExpression(instruction.expression, mod, ids);
            block.push(mod.global.set(id, expr));
        }

        // TODO: make this an expression
        if (instruction.kind === "if-expression") {
            block.push(mod.if(
                compileExpression(instruction.condition, mod, ids),
                compileBlock({ body: instruction.body, mod, ids })
            ));
        }

        if (instruction.kind === "return-statement") {
            block.push(mod.return(compileExpression(instruction.expression, mod, ids)));
        }

        block.push(compileExpression(instruction, mod, ids));
    });

    return mod.block("", block, returnType);
}

function compileExpression(expr: Instruction, mod: binaryen.Module, ids: IdentifiersCollection): number {
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
        if (identifier.kind !== "var") throw new Error("Methods not supported here yet.");
        return mod.global.get(identifier.identifier, getTypeFromString(identifier.type));
    }

    if (expr.kind === "method-or-function-call") {
        if (["+", "-", "*", "/", "<", ">", ">=", "<="].includes(expr.identifier)) {
            return compileBinaryExpression(expr, mod, ids);
        }

        if (expr.identifier === "print") {
            return (mod.call as any)("print", compileExpression(expr.arguments[0], mod, ids), binaryen.none);
        }
    }

    throw new Error(`Invalid expression ${expr.kind}`);
}

function compileBinaryExpression(expr: MethodOrFunctionCall, mod: binaryen.Module, ids: IdentifiersCollection): number {
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

function inferType(expression: Instruction, ids: IdentifiersCollection): number {
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
