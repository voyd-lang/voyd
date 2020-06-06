import { Instruction, AST, FunctionDeclaration, VariableDeclaration, MatchExpression, CallExpression, BinaryExpression, Identifier, PropertyAccessExpression, parse } from "../parser";
import { IRInstruction, IREntity, IRMatchCase, IRFunctionEntity, IRValueEntity, IRTypeEntity } from "./definitions";
import uniqid from "uniqid";
import { IRScope } from "./scope";
import { readFileSync } from "fs";
import { IREntities } from "./entities";

export class DIRModule {
    private readonly entities = new IREntities();
    private readonly deferredCompQueue: (() => void)[] = [];

    compile(code: string) {
        const std = readFileSync(`${__dirname}/../../stdlib/i32.dm`, { encoding: "utf8" });

        const stdScope = new IRScope();
        const stdAST = parse(std);
        this.compileModule(stdAST, stdScope);

        const ast = parse(code);
        const moduleScope = stdScope.newSubScope();
        this.compileModule(ast, moduleScope);
    }


    private compileModule(ast: AST, scope: IRScope) {
        for (const instruction of ast) {
            if (instruction.kind === "type-declaration") {
                const id = this.entities.addEntity({
                    kind: "type",
                    label: instruction.label,
                    flags: instruction.flags,

                    // TODO distinguish static and instance namespaces
                    scope: scope.newSubScope(),
                });
                scope.add(id);
                if (instruction.flags.includes("pub")) scope.export(id);
                continue;
            }

            if (instruction.kind === "function-declaration") {
                this.compileFunction(instruction, scope);
                continue;
            }

            if (instruction.kind === "impl-declaration") {
                const type = scope.accessibleEntitiesWithLabel(instruction.target, this.entities)[0];

                if (!type || type.kind !== "type") {
                    throw new Error(`${instruction.target} is not a type`);
                }

                instruction.functions.forEach(fn => this.compileFunction(fn, type.scope, type.id));
            }
        }

        while (this.deferredCompQueue.length > 0) {
            const func = this.deferredCompQueue.shift();
            if (func) func();
        }
    }

    /**
     * Compile a function or method.
     * @param self - The ID of the type this function is a method of, if any.
     * @returns the ID of the function entity.
     * */
    private compileFunction(fn: FunctionDeclaration, scope: IRScope, self?: string): string {
        const label = fn.label;
        const fnScope = scope.newSubScope();
        const body: IRInstruction[] = [];
        const locals: string[] = [];
        const parameters = this.compileFunctionParameters(fn, fnScope, self);
        const returnType = this.resolveFnReturnType(fn, fnScope);

        // Create the function entity
        const id = this.entities.addEntity({
            kind: "function",
            label,
            flags: fn.flags,
            body,
            parameters,
            locals,
            scope: fnScope,
            returnType,
        });
        scope.add(id);
        if (fn.flags.includes("pub")) scope.export(id);

        this.deferredCompQueue.push(() => {
            // Build the function body
            body.push(...this.compileBlock(fn.body, locals, fnScope));

            this.entities.updateFunction(id, { locals, body });
        });

        return id;
    }

    private resolveFnReturnType(fn: FunctionDeclaration, fnScope: IRScope): string {
        const typeEntity = fn.returnType ?
            fnScope.accessibleEntitiesWithLabel(fn.returnType.label, this.entities)[0] :
            this.inferType(fn.body[fn.body.length - 1], fnScope);

        if (!typeEntity || typeEntity.kind !== "type") {
            throw new Error(`${typeEntity.label} is not a type`);
        }

        return typeEntity.id
    }

    private compileFunctionParameters(fn: FunctionDeclaration, fnScope: IRScope, self?: string) {
        const parameters: string[] = [];

        fn.parameters.forEach(p => {
            const typeEntity = fnScope.accessibleEntitiesWithLabel(p.type!.label, this.entities)[0];

            if (!typeEntity || typeEntity.kind !== "type") {
                throw new Error(`${typeEntity.label} is not a type`);
            }

            const paramID = this.entities.addEntity({
                kind: "value",
                flags: [],
                label: p.label,
                scope: fnScope,
                typeEntity: typeEntity.id
            });

            fnScope.add(paramID);
            parameters.push(paramID);
        });

        if (self) {
            const paramID = this.entities.addEntity({
                kind: "value",
                label: "self",
                flags: fn.flags.includes("mut") ? ["mut"] : [],
                scope: fnScope,
                typeEntity: self
            });

            fnScope.add(paramID);
            parameters.push(paramID);
        }

        return parameters;
    }

    private compileBlock(instructions: Instruction[], locals: string[], scope: IRScope): IRInstruction[] {
        return instructions.map(instruction => {
            if (instruction.kind === "variable-declaration") {
                const variable = this.genVariableIR(instruction, scope);
                this.entities.addEntity(variable);
                scope.add(variable.id)
                locals.push(variable.id);
                if (instruction.initializer) {
                    return {
                        kind: "assignment",
                        assigneeEntityID: variable.id,
                        label: variable.label,
                        expression: this.compileExpression(instruction.initializer, locals, scope)
                    };
                };
                return { kind: "no-op" };
            }

            return this.compileExpression(instruction, locals, scope);
        })
    }

    private compileExpression(expr: Instruction, locals: string[], scope: IRScope): IRInstruction {
        if (expr.kind === "if-expression") {
            const ifScope = scope.newSubScope();
            return {
                kind: "if-expression",
                returnType: this.inferType(expr.body[expr.body.length - 1], ifScope).id,
                condition: this.compileExpression(expr.condition, locals, ifScope),
                body: this.compileBlock(expr.body, locals, ifScope),
                scope: ifScope
            }
        }

        if (expr.kind === "match-expression") {
            return {
                kind: "match-expression",
                value: this.compileExpression(expr.value, locals, scope),
                valueType: this.inferType(expr.value, scope).id,
                returnType: this.inferType(expr.cases[expr.cases.length - 1].expression, scope).id,
                cases: this.compileMatchCases(expr, locals, scope),
                flags: []
            }
        }

        if (expr.kind === "block-expression") {
            const blockScope = scope.newSubScope();
            return {
                kind: "block-expression",
                flags: expr.flags,
                scope: blockScope,
                returnType: this.inferType(expr.body[expr.body.length - 1], blockScope).id,
                body: this.compileBlock(expr.body, locals, blockScope)
            }
        }

        if (expr.kind === "call-expression" || expr.kind === "binary-expression") {
            return this.compileCallExpression(expr, scope, locals);
        }

        if (expr.kind === "break-statement") return { kind: "break-statement" };
        if (expr.kind === "continue-statement") return { kind: "continue-statement" };
        if (expr.kind === "return-statement") {
            return {
                kind: "return-statement",
                expression: this.compileExpression(expr.expression, locals, scope)
            }
        }

        if (expr.kind === "assignment") {
            const assignee = this.resolveEntity(expr.assignee, scope)[0]; // TODO: Assert.
            return {
                kind: "assignment",
                assigneeEntityID: assignee.id,
                label: assignee.label,
                expression: this.compileExpression(expr.expression, locals, scope)
            }
        }

        if (expr.kind === "identifier" || expr.kind === "property-access-expression") {
            const entity = this.resolveEntity(expr, scope)[0];

            return {
                kind: "identifier",
                identifierEntityID: entity.id,
                label: entity.label,
            }
        }

        if (expr.kind === "bool-literal") return expr;
        if (expr.kind === "string-literal") return expr;
        if (expr.kind === "float-literal") return expr;
        if (expr.kind === "int-literal") return expr;

        if (expr.kind === "while-statement") {
            const whileScope = scope.newSubScope();
            return {
                kind: "while-statement",
                condition: this.compileExpression(expr.condition, locals, scope),
                body: this.compileBlock(expr.body, locals, scope),
                scope: whileScope
            }
        }

        throw new Error(`ASTNode, ${expr.kind}, cannot be converted to an instruction`);
    }

    private compileCallExpression(expr: CallExpression | BinaryExpression, scope: IRScope, locals: string[]): IRInstruction {
        const func = this.findCalleeFunctionEntity(expr, scope);
        return {
            kind: "call-expression",
            calleeID: func.id,
            calleeLabel: func.label,
            arguments: expr.arguments.map(arg => this.compileExpression(arg, locals, scope)),
            returnType: func.returnType! // TODO??
        };
    }

    private findCalleeFunctionEntity(expr: CallExpression | BinaryExpression, scope: IRScope): IRFunctionEntity {
        const entities = (
            expr.kind === "call-expression" ?
                this.resolveEntity(expr.callee, scope) :
                this.resolveBinaryFunctionEntity(expr, scope)
        ).filter(v => v.kind === "function") as IRFunctionEntity[];

        if (entities.length === 0) throw new Error(`No function found for ${findLabelForCall(expr)}`);

        for (const entity of entities) {
            const signatureMatches = entity.parameters.every((paramEntityID, index) => {
                const argExpr = expr.arguments[index];
                if (!argExpr) return false;

                // The ID of the type being passed
                const argTypeID = this.inferType(argExpr, scope).id;

                // The ID of the parameter's type
                const paramTypeID = (this.entities.get(paramEntityID) as IRValueEntity).typeEntity;

                return argTypeID === paramTypeID;
            });
            if (signatureMatches) return entity;
        }

        throw new Error(`No function found for ${findLabelForCall(expr)}`);
    }

    private resolveBinaryFunctionEntity(expr: BinaryExpression, scope: IRScope): IREntity[] {
        const operandType = this.inferType(expr.arguments[0], scope);
        return operandType.scope.accessibleEntitiesWithLabel(expr.calleeLabel, this.entities);
    }

    private resolveEntity(expr: PropertyAccessExpression | Identifier, scope: IRScope): IREntity[] {
        if (expr.kind === "identifier") {
            return scope.accessibleEntitiesWithLabel(expr.label, this.entities);
        }

        const parent = this.resolveEntity(expr.arguments[0], scope)[0];
        return this.resolveEntity(expr.arguments[1], parent.scope);
    }

    private compileMatchCases(expr: MatchExpression, locals: string[], scope: IRScope): IRMatchCase[] {
        return expr.cases.map(mCase => ({
            kind: "match-case",
            /** Will need to turn this into a pattern to function compiler */
            case: this.compileExpression(mCase.case, locals, scope),
            expression: this.compileExpression(mCase.expression, locals, scope)
        }));
    }

    private genVariableIR(variable: VariableDeclaration, scope: IRScope): IRValueEntity {
        const id = uniqid();
        const label = variable.label;
        const typeEntity = this.getVariableTypeEntity(variable, scope);

        return {
            kind: "value",
            id, label, typeEntity: typeEntity.id,
            flags: variable.flags,
            scope
        }
    }

    private getVariableTypeEntity(variable: VariableDeclaration, scope: IRScope): IRTypeEntity {
        if (variable.type) {
            const type = scope.accessibleEntitiesWithLabel(variable.type.label, this.entities)[0];
            if (type.kind !== "type") throw new Error(`${variable.type.label} is not a type`);
            return type as IRTypeEntity;
        }

        if (!variable.initializer) throw new Error(`Missing type for ${variable.label}`);
        return this.inferType(variable.initializer, scope);
    }

    /** Returns the expression's result type entity, TODO: ADD ERROR CHECKING IN PLACE OF AS IRTypeEntity */
    private inferType(expr: Instruction, scope: IRScope): IRTypeEntity {
        if (expr.kind === "call-expression") {
            const entity = this.resolveEntity(expr.callee, scope)[0];
            if (!entity || entity.kind !== "function") throw new Error(`${findLabelForCall(expr)} is not a function.`);
            const returnType = (entity as IRFunctionEntity).returnType;
            if (returnType) return this.entities.get(returnType) as IRTypeEntity;
        }

        if (expr.kind === "binary-expression") {
            const operand = this.inferType(expr.arguments[0], scope);
            const entity = operand.scope.accessibleEntitiesWithLabel(expr.calleeLabel, this.entities)[0];
            if (!entity || entity.kind !== "function") throw new Error(`${findLabelForCall(expr)} is not a function.`);
            const returnType = (entity as IRFunctionEntity).returnType;
            if (returnType) return this.entities.get(returnType) as IRTypeEntity;
        }

        if (expr.kind === "identifier") {
            const entity = this.resolveEntity(expr, scope)[0];

            if (!entity) {
                throw new Error(`${expr.label} is not defined`);
            }

            if (entity.kind === "value") return this.entities.get(entity.typeEntity) as IRTypeEntity;
            return entity as IRTypeEntity;
        }

        if (expr.kind === "block-expression") {
            return this.inferType(expr.body[expr.body.length - 1], scope);
        }

        if (expr.kind === "parameter-declaration") {
            if (expr.type) {
                return scope.accessibleEntitiesWithLabel(expr.type.label, this.entities)[0] as IRTypeEntity;
            }

            if (expr.initializer) {
                return this.inferType(expr.initializer, scope);
            }
        }

        const byLabel = (label: string) => scope.accessibleEntitiesWithLabel(label, this.entities)[0];
        if (expr.kind === "bool-literal") return byLabel("bool") as IRTypeEntity;
        if (expr.kind === "float-literal") return byLabel("f32") as IRTypeEntity;
        if (expr.kind === "int-literal") return byLabel("i32") as IRTypeEntity;
        if (expr.kind === "return-statement") return this.inferType(expr.expression, scope);
        if (expr.kind === "if-expression") {
            return this.inferType(expr.body[expr.body.length - 1], scope);
        }

        throw new Error(`Unable to infer type`);
    }
}

function findLabelForCall(call: CallExpression | BinaryExpression): string {
    if (call.kind === "binary-expression") return call.calleeLabel;
    if (call.callee.kind === "identifier") {
        return call.callee.label;
    }

    return (call.callee.arguments[1] as Identifier).label;
}
