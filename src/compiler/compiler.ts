import binaryen from "binaryen";
import { ValueCollection } from "./values";
import { MethodValue, LocalValue } from "./definitions";
import {
    parse, Instruction, MethodOrFunctionCall, ReturnStatement, IfExpression, Assignment,
    MethodDeclaration, VariableDeclaration, WhileStatement, MatchExpression
} from "../parser";
import uniqid from "uniqid";

export function compile(code: string) {
    const ast = parse(code);
    const mod = new binaryen.Module();
    const ids = new ValueCollection();
    mod.autoDrop();
    mod.addFunctionImport("print", "imports", "print", binaryen.i32, binaryen.none);
    mod.addFunction("main", binaryen.none, binaryen.none, [], compileBlock({
        body: ast, mod, vals: ids, returnType: binaryen.none
    }));
    mod.addFunctionExport("main", "main");
    return mod;
}

function compileBlock({
    body, mod, vals, returnType, existingInstructions,
    additionalInstructions, context = "global"
}: {
    body: Instruction[],
    mod: binaryen.Module,
    vals: ValueCollection,
    returnType?: number,
    existingInstructions?: number[],
    additionalInstructions?: number[],
    context?: "global" | "method";
}): number {
    const block: number[] = existingInstructions ?? [];

    body.forEach(instruction => {
        if (instruction.kind === "variable-declaration") {
            compileVariableDeclaration({ instruction, vals, mod, block, context });
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

        if (instruction.kind === "match-expression") {
            compileMatchExpression(block, mod, instruction, vals);
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

// TODO: Support non integer cases.
// TODO: Support patterns (ranges, strings, enum destructuring, etc.)
// TODO: Support default
// TODO: Document how this works. ASAP
function compileMatchExpression(block: number[], mod: binaryen.Module, instruction: MatchExpression, vals: ValueCollection) {
    const indexFunctionName = `match-${uniqid}`;
    const cases: { name: string, case: number, expression: number }[] = [];
    for (const dCase of instruction.cases) {
        const name = JSON.stringify(dCase.case);
        cases.push({
            name,
            case: compileExpression(dCase.case, mod, vals),
            expression: compileExpression(dCase.expression, mod, vals)
        });
    }

    // Build the match indexing function

    const matchBlock: number[] = [
        mod.local.set(0, compileExpression(instruction.value, mod, vals))
    ];

    cases.forEach((cCase, index) => {
        // If the match value is equal to the case, return the block index of the case's expression.
        matchBlock.push(mod.if(
            mod.i32.eq(cCase.case, mod.local.get(0, binaryen.i32)),
            mod.return(mod.i32.const(index))
        ))
    });

    mod.addFunction(indexFunctionName, binaryen.createType([]), binaryen.i32, [binaryen.i32], mod.block("", matchBlock));

    // Convert the 1D cases array to a hierarchical set of blocks, last one containing the switch (br_table).
    // TODO: Make this iterative.
    function makeBlockTree(caseIndex = 0): number {
        const cCase = cases[caseIndex];

        if (cCase) {
            return mod.block(cCase.name, [
                makeBlockTree(caseIndex + 1),
                cCase.expression
            ]);
        }

        return mod.block("matcher", [
            mod.switch(cases.map(c => c.name), cases[0].name, mod.call(indexFunctionName, [], binaryen.i32))
        ]);
    }

    return makeBlockTree();
}

function compileReturn(block: number[], mod: binaryen.Module, instruction: ReturnStatement, vals: ValueCollection) {
    block.push(mod.return(compileExpression(instruction.expression, mod, vals)));
}

function compileIfExpression(block: number[], mod: binaryen.Module, instruction: IfExpression, vals: ValueCollection) {
    block.push(
        mod.if(compileExpression(instruction.condition, mod, vals),
            compileBlock({ body: instruction.body, mod, vals: vals }))
    );
}

function compileWhileStatement(block: number[], mod: binaryen.Module, instruction: WhileStatement, vals: ValueCollection) {
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

function compileAssignment(instruction: Assignment, mod: binaryen.Module, vals: ValueCollection, block: number[]) {
    const id = instruction.identifier;
    const expr = compileExpression(instruction.expression, mod, vals);
    const val = vals.retrieve(id);

    if (val.kind === "method" || !val.mutable) {
        throw new Error(`${id} cannot be reassigned`);
    }

    if (val.kind === "local") {
        block.push(mod.local.set(val.index, expr));
        return;
    }

    block.push(mod.global.set(id, expr));
}

function compileMethodDeclaration(instruction: MethodDeclaration, vals: ValueCollection, mod: binaryen.Module) {
    const id = instruction.identifier;
    const internalVals = vals.clone();
    const params = instruction.parameters.map((param, index) => {
        const type = getTypeFromString(param.type!.identifier);
        internalVals.register({
            kind: "local",
            mutable: false,
            type, flags: [],
            id: param.identifier,
            index
        });
        return type;
    });

    const returnType = instruction.returnType ?
        getTypeFromString(instruction.returnType.identifier) :
        binaryen.none;

    const method: MethodValue = {
        kind: "method",
        id,
        parameters: params,
        returnType,
        flags: instruction.flags ?? []
    };
    internalVals.register(method);
    vals.register(method);

    const methodBody = compileBlock({
        body: instruction.body,
        mod,
        vals: internalVals,
        returnType,
        context: "method",
    });
    const additionalLocals = internalVals.getNonParameterLocalTypes();

    mod.addFunction(id, binaryen.createType(params), returnType, additionalLocals, methodBody);
}

function compileVariableDeclaration({
    instruction, vals, mod, block, context = "global"
}: {
    instruction: VariableDeclaration, vals: ValueCollection, mod: binaryen.Module, block: number[],
    context?: "global" | "method"
}) {
    const id = instruction.identifiers[0];
    const type = instruction.type ?
        getTypeFromString(instruction.type.identifier) :
        inferType(instruction.initializer!, vals);

    if (context === "method") {
        vals.register({
            kind: "local",
            id, type,
            flags: instruction.flags,
            nonParameter: true,
            mutable: instruction.flags.includes("var"),
            index: 0
        });

        if (instruction.initializer) {
            const local = vals.retrieve(id) as LocalValue;
            block.push(mod.local.set(
                local.index,
                compileExpression(instruction.initializer, mod, vals)
            ))
        }

        return;
    }

    mod.addGlobal(id, type, true, globalInit(type, mod));

    vals.register({
        kind: "global",
        id,
        type,
        mutable: instruction.flags.includes("var"),
        flags: instruction.flags
    });

    if (instruction.initializer) {
        block.push(mod.global.set(id, compileExpression(instruction.initializer, mod, vals)));
    }
}

function compileExpression(expr: Instruction, mod: binaryen.Module, vals: ValueCollection): number {
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
        const identifier = vals.retrieve(expr.value);

        if (identifier.kind === "local") {
            return mod.local.get(identifier.index, identifier.type);
        }

        if (identifier.kind === "global") {
            return mod.global.get(identifier.id, identifier.type);
        }

        throw new Error(`Unsupported identifier type in expression: ${identifier.kind}`);
    }

    if (expr.kind === "method-or-function-call") {
        if (["+", "-", "*", "/", "<", ">", ">=", "<="].includes(expr.identifier)) {
            return compileBinaryExpression(expr, mod, vals);
        }

        if (expr.identifier === "print") {
            return (mod.call as any)("print", [compileExpression(expr.arguments[0], mod, vals)], binaryen.none);
        }

        const val = vals.retrieve(expr.identifier);
        if (val.kind !== "method") throw new Error(`${expr.identifier} is not a method`);
        const args = expr.arguments.map(instr => compileExpression(instr, mod, vals));
        return (mod.call as any)(val.id, args, val.returnType);
    }

    throw new Error(`Invalid expression ${expr.kind}`);
}

function compileBinaryExpression(expr: MethodOrFunctionCall, mod: binaryen.Module, ids: ValueCollection): number {
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

function inferType(expression: Instruction, ids: ValueCollection): number {
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
        return identifier.returnType;
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
