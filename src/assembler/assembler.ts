import binaryen from "binaryen";
import { TypeAlias, VariableEntity } from "../definitions";
import {
    Instruction, ReturnStatement, IfExpression, Assignment,
    FunctionDeclaration, VariableDeclaration, WhileStatement, MatchExpression, AST, Identifier
} from "../parser";
import uniqid from "uniqid";
import { Scope } from "../scope";

export class Assembler {
    private readonly mod = new binaryen.Module();

    constructor() {
        this.mod.autoDrop();
        this.mod.addFunctionImport("print", "imports", "print", binaryen.i32, binaryen.none);
    }

    compile(ast: AST) {
        this.walkInstructions(ast.body, ast.scope);
        return this.mod;
    }

    private walkInstructions(instructions: Instruction[], scope: Scope) {
        for (const instruction of instructions) {
            if (instruction.kind === "type-declaration") {
                // TODO.
                continue;
            }

            if (instruction.kind === "function-declaration") {
                this.compileFn(instruction);
                continue;
            }

            if (instruction.kind === "impl-declaration") {
                const type = scope.closestEntityWithLabel(instruction.target, ["type-alias"]);

                if (!type) {
                    throw new Error(`${instruction.target} is not a type`);
                }

                instruction.functions.forEach(fn => this.compileFn(fn));
            }
        }
    }

    private compileFn(fn: FunctionDeclaration): number {
        const expression = this.compileExpression(fn.expression!, fn.scope);
        const binParams = binaryen.createType(fn.parameters.map(p => {
            return this.getBinType(fn.scope.closestEntityWithLabel(p.type!.label, ["type-alias"]) as TypeAlias)
        }));
        const binReturnType = this.getBinType(fn.scope.closestEntityWithLabel(fn.returnType!.label, ["type-alias"]) as TypeAlias);
        const binLocals = fn.scope.locals.map(id => {
            const entity = fn.scope.entities.get(id) as VariableEntity;
            return this.getBinType(fn.scope.closestEntityWithLabel(entity.typeLabel!, ["type-alias"]) as TypeAlias);
        });

        return this.mod.addFunction(fn.id!, binParams, binReturnType, binLocals, expression);
    }

    private compileExpression(expr: Instruction, scope: Scope): number {
        if (expr.kind === "if-expression") {
            return this.compileIfExpression(expr);
        }

        if (expr.kind === "while-statement") {
            return this.compileWhileStatement(expr, scope);
        }

        if (expr.kind === "match-expression") {
            return this.compileMatchExpression(expr, scope);
        }

        if (expr.kind === "return-statement") {
            return this.compileReturn(expr, scope);
        }

        if (expr.kind === "int-literal") {
            return this.mod.i32.const(Number(expr.value));
        }

        if (expr.kind === "float-literal") {
            return this.mod.f32.const(Number(expr.value));
        }

        if (expr.kind === "bool-literal") {
            return this.mod.i32.const(expr.value ? 1 : 0);
        }

        if (expr.kind === "identifier") {

            if (identifier.kind === "local") {
                return mod.local.get(identifier.index, identifier.type);
            }

            if (identifier.kind === "global") {
                return mod.global.get(identifier.id, identifier.type);
            }

            throw new Error(`Unsupported identifier type in expression: ${identifier.kind}`);
        }

        if (expr.kind === "binary-expression") {
            return this.compileBinaryExpression(expr, mod, vals);
        }

        if (expr.kind === "call-expression") {
            // TODO: Add to vals as stdlib
            if (expr.calleeLabel === "print") {
                return (mod.call as any)("print", [compileExpression(expr.arguments[0], mod, vals)], binaryen.none);
            }

            const val = vals.retrieve(expr.calleeLabel);
            if (val.kind !== "method") throw new Error(`${expr.calleeLabel} is not a method`);
            const args = expr.arguments.map(instr => compileExpression(instr, mod, vals));
            return (mod.call as any)(val.id, args, val.returnType);
        }

        throw new Error(`Invalid expression ${expr.kind}`);
    }

    private compileIfExpression(instruction: IfExpression) {
        return this.mod.if(
            this.compileExpression(instruction.condition, instruction.scope),
            this.compileBlock(instruction)
        );
    }

    private compileBlock(block: AST, prepend: number[] = [], append: number[] = []): number {
        return this.mod.block("", [
            ...prepend,
            ...block.body.map(instruction => {
                if (instruction.kind === "variable-declaration") {
                    return this.compileVariableDeclaration(instruction, block.scope);
                }

                if (instruction.kind === "function-declaration") {
                    return this.compileFn(instruction);
                }

                if (instruction.kind === "assignment") {
                    return this.compileAssignment(instruction, block.scope);
                }

                return this.compileExpression(instruction, block.scope);
            }),
            ...append
        ]);
    }

    compileAssignment(instruction: Assignment, scope: Scope): number {
        const assignee = scope.entities.get((instruction.assignee as Identifier).id!)! as VariableEntity;
        const expr = this.compileExpression(instruction.expression, scope);
        return this.mod.local.set(assignee.index, expr)
    }

    private compileVariableDeclaration(vr: VariableDeclaration, scope: Scope): number {
        if (!vr.initializer) return this.mod.nop();
        return this.compileAssignment({
            kind: "assignment",
            assignee: { kind: "identifier", label: "no", id: vr.id! },
            expression: vr.initializer
        }, scope);
    }

    // TODO: Support non integer cases.
    // TODO: Support patterns (ranges, strings, enum destructuring, etc.)
    // TODO: Support default
    // TODO: Document how this works. ASAP
    private compileMatchExpression(instruction: MatchExpression, scope: Scope): number {
        const indexFunctionName = `match-${uniqid()}`;
        const cases: { name: string, case: number, expression: number }[] = [];
        for (const dCase of instruction.cases) {
            const name = JSON.stringify(dCase.case);
            cases.push({
                name,
                case: this.compileExpression(dCase.case, scope),
                expression: this.compileExpression(dCase.expression, scope)
            });
        }

        // Build the match indexing function
        const matchBlock: number[] = [
            this.mod.local.set(0, this.compileExpression(instruction.value, scope))
        ];

        cases.forEach((cCase, index) => {
            // If the match value is equal to the case, return the block index of the case's expression.
            matchBlock.push(this.mod.if(
                this.mod.i32.eq(cCase.case, this.mod.local.get(0, binaryen.i32)),
                this.mod.return(this.mod.i32.const(index + 1))
            ))
        });

        matchBlock.push(this.mod.i32.const(0));

        this.mod.addFunction(indexFunctionName, binaryen.createType([]), binaryen.i32, [binaryen.i32], this.mod.block("", matchBlock, binaryen.i32));

        // Convert the 1D cases array to a hierarchical set of blocks, last one containing the switch (br_table).
        // TODO: Make this iterative.
        const makeBlockTree = (caseIndex = 0): number => {
            const cCase = cases[caseIndex];

            if (cCase) {
                return this.mod.block(cCase.name, [
                    makeBlockTree(caseIndex + 1),
                    cCase.expression,
                    this.mod.br("match")
                ]);
            }

            return this.mod.block("matcher", [
                this.mod.switch(
                    [...cases.map(c => c.name), "matcher"],
                    cases[0].name,
                    this.mod.call(indexFunctionName, [], binaryen.i32)
                )
            ]);
        }

        return this.mod.block("match", [makeBlockTree()]);
    }

    private compileReturn(instruction: ReturnStatement, scope: Scope) {
        return this.mod.return(this.compileExpression(instruction.expression, scope))
    }

    private compileWhileStatement(instruction: WhileStatement, scope: Scope) {
        return this.mod.block("while", [
            this.mod.loop("loop",
                this.compileBlock(
                    instruction,
                    [
                        this.mod.br("while", this.mod.i32.ne(
                            this.compileExpression(instruction.condition, scope),
                            this.mod.i32.const(1)
                        ))
                    ],
                    [
                        this.mod.br("loop")
                    ]
                )
            )
        ]);
    }

    private getBinType(type: TypeAlias): number {
        if (!type.flags.includes("declare")) {
            throw new Error(`Unsupported type alias ${type.label}`);
        }

        if (type.label === "i32") {
            return binaryen.i32;
        }

        throw new Error(`Unsupported type alias ${type.label}`);
    }
}
