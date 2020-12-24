import binaryen from "binaryen";
import { Assignment, BinaryExpression, Block, BoolLiteral, Call, ContainerNode, ExpressionNode, FloatLiteral, FunctionNode, Identifier, If, Impl, IntLiteral, Node, Parameter, PropertyAccess, Return, StructLiteral, StructLiteralField, TypeAlias, TypeNode, Variable, While } from "../ast";

export class Assembler {
    readonly mod = new binaryen.Module();

    constructor() {
        this.mod.setFeatures(512); // Temp workaround till binaryen.js #36 is published
        this.mod.autoDrop();
        this.mod.addFunctionImport("print", "imports", "print", binaryen.i32, binaryen.none);
    }

    compile(node: ContainerNode): void {
        for (const instruction of node.children) {
            if (instruction instanceof FunctionNode) {
                this.compileFn(instruction);
                continue;
            }

            if (instruction instanceof ContainerNode) {
                this.compile(instruction);
                continue;
            }

            if (instruction instanceof Impl) {
                instruction.functions.forEach(fn => this.compileFn(fn));
                continue;
            }
        }
    }

    private compileFn(fn: FunctionNode): number {
        if (!fn.expression) return this.mod.nop();

        const expression = this.compileExpression(fn.expression, fn);
        const binParams = binaryen.createType(fn.parameters.map(param => this.getBinType(param.type)));
        const binReturnType = this.getBinType(fn.returnType);
        const binLocals = fn.variables.map(variable => this.getBinType(variable.type));

        const id = fn.name === "main" ? "main" : fn.id!;
        const modId = this.mod.addFunction(id, binParams, binReturnType, binLocals, expression);

        if (id === "main") {
            this.mod.addFunctionExport("main", "main");
        }

        return modId;
    }

    private compileExpression(expr: Node, container: ContainerNode): number {
        if (expr instanceof If) {
            return this.compileIfExpression(expr, container);
        }

        if (expr instanceof While) {
            return this.compileWhileStatement(expr, container);
        }


        if (expr instanceof Return) {
            return this.compileReturn(expr, container);
        }

        if (expr instanceof StructLiteral) {
            return this.compileStructLiteral(expr, container);
        }

        if (expr instanceof IntLiteral) {
            return this.mod.i32.const(Number(expr.value));
        }

        if (expr instanceof FloatLiteral) {
            return this.mod.f32.const(Number(expr.value));
        }

        if (expr instanceof BoolLiteral) {
            return this.mod.i32.const(expr.value ? 1 : 0);
        }

        if (expr instanceof Identifier) {
            const entity = expr.ref() as (Variable | Parameter)
            return this.mod.local.get(entity.localIndex!, this.getBinType(entity.type));
        }

        if (expr instanceof BinaryExpression) {
            const fn = expr.callee;
            return this.mod.call(fn.id, [
                this.compileExpression(expr.arguments[0], container),
                this.compileExpression(expr.arguments[1], container)
            ], this.getBinType(fn.returnType));
        }

        if (expr instanceof Call) {
            const builtIn = this.getBuiltIn(expr.calleeName, container);
            if (builtIn) return builtIn(expr);

            const fn = expr.callee;
            const args = expr.arguments.map(instr => this.compileExpression(instr, container));
            return this.mod.call(fn.id, args, this.getBinType(fn.returnType));
        }

        if (expr instanceof PropertyAccess) {
            return this.compilePropertyAccessExpression(expr, container);
        }

        if (expr instanceof Block) {
            return this.compileBlock(expr);
        }

        throw new Error(`Invalid expression ${expr}`);
    }

    private compileStructLiteral(expr: StructLiteral, scope: ContainerNode): number {
        const elements: number[] = [];

        for (const label in expr.fields) {
            elements.push(this.compileExpression(expr.fields[label].initializer, scope));
        }

        return this.mod.tuple.make(elements);
    }

    private compilePropertyAccessExpression(expr: PropertyAccess, scope: ContainerNode) {
        const left = expr.left;
        const right = expr.right;

        if (right instanceof Identifier) {
            const entity = right.ref() as StructLiteralField;
            return this.mod.tuple.extract(this.compileExpression(left, scope), entity.index);
        }

        if (!(right instanceof Call)) {
            throw new Error("Right side property access expression type not yet supported");
        }

        const builtIn = this.getBuiltIn(right.calleeName, scope);
        if (builtIn) {
            right.arguments.unshift(left);
            return builtIn(right);
        }

        const fn = right.callee;

        return this.mod.call(fn.id, [
            this.compileExpression(left, scope),
            ...right.arguments.map(expr => this.compileExpression(expr, scope))
        ], this.getBinType(fn.returnType))
    }

    private compileIfExpression(instruction: If, container: ContainerNode) {
        return this.mod.if(
            this.compileExpression(instruction.condition, container),
            this.compileBlock(instruction.block),
            instruction.elseBlock ? this.compileBlock(instruction.elseBlock) : undefined
        );
    }

    private compileBlock(block: Block, prepend: number[] = [], append: number[] = []): number {
        return this.mod.block("", [
            ...prepend,
            ...block.children.map(instruction => {
                if (instruction instanceof Variable) {
                    return this.compileVariableDeclaration(instruction, block);
                }

                if (instruction instanceof FunctionNode) {
                    return this.compileFn(instruction);
                }

                if (instruction instanceof Assignment) {
                    return this.compileAssignment(instruction, block);
                }

                return this.compileExpression(instruction, block);
            }),
            ...append
        ], binaryen.auto);
    }

    compileAssignment(instruction: Assignment, scope: ContainerNode): number {
        if (instruction.assignee instanceof Identifier) {
            const assignee = instruction.assignee.ref() as Variable;
            const expr = this.compileExpression(instruction.expression, scope);
            return this.mod.local.set(assignee.localIndex!, expr);
        }

        if (instruction.assignee instanceof Variable) {
            const assignee = instruction.assignee;
            const expr = this.compileExpression(instruction.expression, scope);
            return this.mod.local.set(assignee.localIndex!, expr);
        }

        return this.compilePropertyAccessAssignment({
            expr: instruction.assignee,
            initializer: instruction.expression,
            scope
        });
    }

    compilePropertyAccessAssignment({ expr, initializer, scope }: {
        expr: PropertyAccess;
        initializer: ExpressionNode;
        scope: ContainerNode;
    }): number {
        const identifiers = this.flattenPropertyAccessAssignmentExpr(expr);
        console.dir(identifiers);
        const topIdentifier = identifiers.shift()!
        const variable = scope.getSymbol(topIdentifier.id) as Variable;
        const struct = variable.type as StructLiteral;
        const modifiedField = scope.getSymbol(identifiers.shift()!.id!) as StructLiteralField;

        return this.mod.local.set(variable.localIndex!, this.mod.tuple.make(this.buildStructTree({
            tuple: this.mod.local.get(variable.localIndex!, this.getBinType(struct)),
            struct, modifiedField, scope, identifiers, initializer
        })));
    }

    /** The complexity of this function fills me with pain. */
    buildStructTree({ struct, tuple, modifiedField, scope, identifiers, initializer }: {
        struct: StructLiteral; tuple: number; modifiedField: StructLiteralField;
        scope: ContainerNode; identifiers: Identifier[]; initializer: ExpressionNode;
    }): number[] {
        const elements: number[] = [];
        const nextFieldIdentifier = identifiers.shift();
        const nextField = nextFieldIdentifier ?
            (scope.getSymbol(nextFieldIdentifier.id!) as StructLiteralField) :
            undefined;

        for (const id in struct.fields) {
            const field = struct.fields[id];

            if (field.index !== modifiedField.index) {
                elements.push(this.mod.tuple.extract(tuple, field.index));
                continue;
            }

            if (!nextField) {
                elements.push(this.compileExpression(initializer, scope));
                continue;
            }

            elements.push(
                this.mod.tuple.make(
                    this.buildStructTree({
                        struct: modifiedField.type as StructLiteral,
                        tuple: this.mod.tuple.extract(tuple, field.index),
                        modifiedField: nextField,
                        scope, identifiers, initializer
                    })
                )
            );
        }

        return elements;
    }

    /** converts a.b.c tree to [a, b, c] */
    flattenPropertyAccessAssignmentExpr(expr: PropertyAccess): Identifier[] {
        const left = expr.left;
        const right = expr.right;

        if (!(right instanceof Identifier)) {
            throw new Error("Invalid property access assignment expression.");
        }

        if (left instanceof Identifier) {
            return [left, right];
        }

        if (left instanceof PropertyAccess) {
            return [...this.flattenPropertyAccessAssignmentExpr(left), right];
        }

        throw new Error("Invalid property access assignment expression.");
    }

    private compileVariableDeclaration(vr: Variable, scope: ContainerNode): number {
        if (!vr.initializer) return this.mod.nop();
        return this.compileAssignment(new Assignment({ assignee: vr, expression: vr.initializer, parent: scope }), scope);
    }

    private compileReturn(instruction: Return, scope: ContainerNode) {
        return this.mod.return(instruction.expression ? this.compileExpression(instruction.expression, scope) : undefined)
    }

    private compileWhileStatement(instruction: While, scope: ContainerNode) {
        return this.mod.block("while", [
            this.mod.loop("loop",
                this.compileBlock(
                    instruction.block,
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

    private getBinType(type: TypeNode | StructLiteral): number {
        if (type instanceof StructLiteral) {
            return binaryen.createType(Object.entries(type.fields).map(([, field]) => this.getBinType(field.type! as any)));
        }

        if (!type.flags.includes("declare")) {
            throw new Error(`Unsupported type alias ${type.name}`);
        }

        if (type.name === "i32") {
            return binaryen.i32;
        }

        if (type.name === "Void") {
            return binaryen.none;
        }

        throw new Error(`Unsupported type alias ${type.name}`);
    }

    private getBuiltIn(name: string, scope: ContainerNode): ((expr: Call) => number) | void {
        return ({
            "print": expr =>
                this.mod.call("print", [this.compileExpression(expr.arguments[0], scope)], binaryen.none),
            "i32_add": expr => this.mod.i32.add(
                this.compileExpression(expr.arguments[0], scope),
                this.compileExpression(expr.arguments[1], scope)
            ),
            "i32_sub": expr => this.mod.i32.sub(
                this.compileExpression(expr.arguments[0], scope),
                this.compileExpression(expr.arguments[1], scope)
            ),
            "i32_div_s": expr => this.mod.i32.div_s(
                this.compileExpression(expr.arguments[0], scope),
                this.compileExpression(expr.arguments[1], scope)
            ),
            "i32_mul": expr => this.mod.i32.mul(
                this.compileExpression(expr.arguments[0], scope),
                this.compileExpression(expr.arguments[1], scope)
            ),
            "i32_eq": expr => this.mod.i32.eq(
                this.compileExpression(expr.arguments[0], scope),
                this.compileExpression(expr.arguments[1], scope)
            ),
            "i32_gt_s": expr => this.mod.i32.gt_s(
                this.compileExpression(expr.arguments[0], scope),
                this.compileExpression(expr.arguments[1], scope)
            ),
            "i32_lt_s": expr => this.mod.i32.lt_s(
                this.compileExpression(expr.arguments[0], scope),
                this.compileExpression(expr.arguments[1], scope)
            ),
            "i32_ge_s": expr => this.mod.i32.add(
                this.compileExpression(expr.arguments[0], scope),
                this.compileExpression(expr.arguments[1], scope)
            ),
            "i32_le_s": expr => this.mod.i32.le_s(
                this.compileExpression(expr.arguments[0], scope),
                this.compileExpression(expr.arguments[1], scope)
            ),
            "i32_and": expr => this.mod.i32.and(
                this.compileExpression(expr.arguments[0], scope),
                this.compileExpression(expr.arguments[1], scope)
            ),
            "i32_or": expr => this.mod.i32.or(
                this.compileExpression(expr.arguments[0], scope),
                this.compileExpression(expr.arguments[1], scope)
            )
        } as Record<string, (expr: Call) => number>)[name];
    }
}
