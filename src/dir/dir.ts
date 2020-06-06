import { Instruction, AST, FunctionDeclaration, VariableDeclaration, MatchExpression, CallExpression, BinaryExpression, Identifier, PropertyAccessExpression, parse } from "../parser";
import { IRInstruction, IREntity, IRMatchCase, IRFunctionEntity, IRValueEntity, IRTypeEntity } from "./definitions";
import uniqid from "uniqid";
import { IR } from "./ir";
import { readFileSync } from "fs";

export class DIRCompiler {
    private readonly ir = new IR();
    private readonly deferredCompQueue: (() => void)[] = [];

    compile(code: string) {
        const std = readFileSync(`${__dirname}/../../stdlib/i32.dm`, { encoding: "utf8" });
        const stdAST = parse(std);
        this.compileModule(stdAST, this.ir.stdNamespaceID);
        const ast = parse(code);
        const namespace = this.ir.newNamespace();
        this.compileModule(ast, namespace);
        this.ir.logEntitiesOfNamespace(namespace);
    }

    private compileModule(ast: AST, namespace: string) {
        for (const instruction of ast) {
            if (instruction.kind === "type-declaration") {
                const typeNamespace = this.ir.newNamespace(namespace);
                this.ir.addEntity({
                    kind: "type",
                    label: instruction.label,
                    flags: instruction.flags,

                    // TODO distinguish static and instance namespaces
                    namespace: typeNamespace,
                }, namespace);

                continue;
            }

            if (instruction.kind === "function-declaration") {
                this.compileFunction(instruction, namespace);
                continue;
            }

            if (instruction.kind === "impl-declaration") {
                const type = this.ir.findEntitiesWithLabel(instruction.target, namespace)[0];

                if (!type || type.kind !== "type") {
                    throw new Error(`${instruction.target} is not a type`);
                }

                instruction.functions.forEach(fn => this.compileFunction(fn, type.namespace, type.id));
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
    private compileFunction(fn: FunctionDeclaration, namespace: string, self?: string): string {
        const label = fn.label;
        const fnNamespace = this.ir.newNamespace(namespace);
        const body: IRInstruction[] = [];
        const locals: string[] = [];
        const parameters = this.compileFunctionParameters(fn, fnNamespace, self);
        const returnType = this.resolveFnReturnType(fn, fnNamespace);

        // Create the function entity
        const id = this.ir.addEntity({
            kind: "function",
            label,
            flags: fn.flags,
            body,
            parameters,
            locals,
            namespace: fnNamespace,
            returnType,
        }, namespace);

        this.deferredCompQueue.push(() => {
            // Build the function body
            body.push(...this.compileBlock(fn.body, locals, fnNamespace));

            this.ir.updateFunction(id, { locals, body });
        });

        return id;
    }

    private resolveFnReturnType(fn: FunctionDeclaration, internalNamespace: string): string {
        const typeEntity = fn.returnType ?
            this.ir.findEntitiesWithLabel(fn.returnType.label, internalNamespace)[0] :
            this.inferType(fn.body[fn.body.length - 1], internalNamespace);

        if (!typeEntity || typeEntity.kind !== "type") {
            throw new Error(`${typeEntity.label} is not a type`);
        }

        return typeEntity.id
    }

    private compileFunctionParameters(fn: FunctionDeclaration, internalNamespace: string, self?: string) {
        const parameters: string[] = [];

        fn.parameters.forEach(p => {
            const typeEntity = this.ir.findEntitiesWithLabel(p.type!.label, internalNamespace)[0];

            if (!typeEntity || typeEntity.kind !== "type") {
                throw new Error(`${typeEntity.label} is not a type`);
            }

            const paramID = this.ir.addEntity({
                kind: "value",
                flags: [],
                label: p.label,
                namespace: internalNamespace,
                typeEntity: typeEntity.id
            }, internalNamespace);

            parameters.push(paramID);
        });

        if (self) {
            const paramID = this.ir.addEntity({
                kind: "value",
                label: "self",
                flags: fn.flags.includes("mut") ? ["mut"] : [],
                namespace: internalNamespace,
                typeEntity: self
            }, internalNamespace);

            parameters.push(paramID);
        }

        return parameters;
    }

    private compileBlock(instructions: Instruction[], locals: string[], namespace: string): IRInstruction[] {
        return instructions.map(instruction => {
            if (instruction.kind === "variable-declaration") {
                const variable = this.genVariableIR(instruction, namespace);
                this.ir.addEntity(variable, namespace);
                locals.push(variable.id);
                if (instruction.initializer) {
                    return {
                        kind: "assignment",
                        assigneeEntityID: variable.id,
                        label: variable.label,
                        expression: this.compileExpression(instruction.initializer, locals, namespace)
                    };
                };
                return { kind: "no-op" };
            }

            return this.compileExpression(instruction, locals, namespace);
        })
    }

    private compileExpression(expr: Instruction, locals: string[], namespace: string): IRInstruction {
        if (expr.kind === "if-expression") {
            const ifNamespace = this.ir.newNamespace(namespace);
            return {
                kind: "if-expression",
                returnType: this.inferType(expr.body[expr.body.length - 1], ifNamespace).id,
                condition: this.compileExpression(expr.condition, locals, ifNamespace),
                body: this.compileBlock(expr.body, locals, ifNamespace),
                namespace: ifNamespace
            }
        }

        if (expr.kind === "match-expression") {
            return {
                kind: "match-expression",
                value: this.compileExpression(expr.value, locals, namespace),
                valueType: this.inferType(expr.value, namespace).id,
                returnType: this.inferType(expr.cases[expr.cases.length - 1].expression, namespace).id,
                cases: this.compileMatchCases(expr, locals, namespace),
                flags: []
            }
        }

        if (expr.kind === "block-expression") {
            const blockNamespace = this.ir.newNamespace(namespace);
            return {
                kind: "block-expression",
                flags: expr.flags,
                namespace: blockNamespace,
                returnType: this.inferType(expr.body[expr.body.length - 1], blockNamespace).id,
                body: this.compileBlock(expr.body, locals, blockNamespace)
            }
        }

        if (expr.kind === "call-expression" || expr.kind === "binary-expression") {
            return this.compileCallExpression(expr, namespace, locals);
        }

        if (expr.kind === "break-statement") return { kind: "break-statement" };
        if (expr.kind === "continue-statement") return { kind: "continue-statement" };
        if (expr.kind === "return-statement") {
            return {
                kind: "return-statement",
                expression: this.compileExpression(expr.expression, locals, namespace)
            }
        }

        if (expr.kind === "assignment") {
            const assignee = this.resolveEntity(expr.assignee, namespace)[0]; // TODO: Assert.
            return {
                kind: "assignment",
                assigneeEntityID: assignee.id,
                label: assignee.label,
                expression: this.compileExpression(expr.expression, locals, namespace)
            }
        }

        if (expr.kind === "identifier" || expr.kind === "property-access-expression") {
            const entity = this.resolveEntity(expr, namespace)[0];

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
            const whileNamespace = this.ir.newNamespace(namespace);
            return {
                kind: "while-statement",
                condition: this.compileExpression(expr.condition, locals, namespace),
                body: this.compileBlock(expr.body, locals, namespace),
                namespace: whileNamespace
            }
        }

        throw new Error(`ASTNode, ${expr.kind}, cannot be converted to an instruction`);
    }

    private compileCallExpression(expr: CallExpression | BinaryExpression, namespace: string, locals: string[]): IRInstruction {
        const func = this.findCalleeFunctionEntity(expr, namespace);
        return {
            kind: "call-expression",
            calleeID: func.id,
            calleeLabel: func.label,
            arguments: expr.arguments.map(arg => this.compileExpression(arg, locals, namespace)),
            returnType: func.returnType! // TODO??
        };
    }

    private findCalleeFunctionEntity(expr: CallExpression | BinaryExpression, namespace: string): IRFunctionEntity {
        const entities = (
            expr.kind === "call-expression" ?
                this.resolveEntity(expr.callee, namespace) :
                this.resolveBinaryFunctionEntity(expr, namespace)
        ).filter(v => v.kind === "function") as IRFunctionEntity[];

        if (entities.length === 0) throw new Error(`No function found for ${findLabelForCall(expr)}`);

        for (const entity of entities) {
            const signatureMatches = entity.parameters.every((paramEntityID, index) => {
                const argExpr = expr.arguments[index];
                if (!argExpr) return false;

                // The ID of the type being passed
                const argTypeID = this.inferType(argExpr, namespace).id;

                // The ID of the parameter's type
                const paramTypeID = (this.ir.getEntity(paramEntityID) as IRValueEntity).typeEntity;

                return argTypeID === paramTypeID;
            });
            if (signatureMatches) return entity;
        }

        throw new Error(`No function found for ${findLabelForCall(expr)}`);
    }

    private resolveBinaryFunctionEntity(expr: BinaryExpression, namespace: string): IREntity[] {
        const operandType = this.inferType(expr.arguments[0], namespace);
        return this.ir.findEntitiesWithLabel(expr.calleeLabel, operandType.namespace);
    }

    private resolveEntity(expr: PropertyAccessExpression | Identifier, namespace: string): IREntity[] {
        if (expr.kind === "identifier") {
            return this.ir.findEntitiesWithLabel(expr.label, namespace);
        }

        const parent = this.resolveEntity(expr.arguments[0], namespace)[0];
        return this.resolveEntity(expr.arguments[1], parent.namespace);
    }

    private compileMatchCases(expr: MatchExpression, locals: string[], namespace: string): IRMatchCase[] {
        return expr.cases.map(mCase => ({
            kind: "match-case",
            /** Will need to turn this into a pattern to function compiler */
            case: this.compileExpression(mCase.case, locals, namespace),
            expression: this.compileExpression(mCase.expression, locals, namespace)
        }));
    }

    private genVariableIR(variable: VariableDeclaration, namespace: string): IRValueEntity {
        const id = uniqid();
        const label = variable.label;
        const typeEntity = this.getVariableTypeEntity(variable, namespace);

        return {
            kind: "value",
            id, label, typeEntity: typeEntity.id,
            flags: variable.flags,
            namespace
        }
    }

    private getVariableTypeEntity(variable: VariableDeclaration, namespace: string): IRTypeEntity {
        if (variable.type) {
            const type = this.ir.findEntitiesWithLabel(variable.type.label, namespace)[0];
            if (type.kind !== "type") throw new Error(`${variable.type.label} is not a type`);
            return type as IRTypeEntity;
        }

        if (!variable.initializer) throw new Error(`Missing type for ${variable.label}`);
        return this.inferType(variable.initializer, namespace);
    }

    /** Returns the expression's result type entity, TODO: ADD ERROR CHECKING IN PLACE OF AS IRTypeEntity */
    private inferType(expr: Instruction, namespace: string): IRTypeEntity {
        if (expr.kind === "call-expression") {
            const entity = this.resolveEntity(expr.callee, namespace)[0];
            if (!entity || entity.kind !== "function") throw new Error(`${findLabelForCall(expr)} is not a function.`);
            const returnType = (entity as IRFunctionEntity).returnType;
            if (returnType) return this.ir.getEntity(returnType) as IRTypeEntity;
        }

        if (expr.kind === "binary-expression") {
            const operand = this.inferType(expr.arguments[0], namespace);
            const entity = this.ir.findEntitiesWithLabel(expr.calleeLabel, operand.namespace)[0];
            if (!entity || entity.kind !== "function") throw new Error(`${findLabelForCall(expr)} is not a function.`);
            const returnType = (entity as IRFunctionEntity).returnType;
            if (returnType) return this.ir.getEntity(returnType) as IRTypeEntity;
        }

        if (expr.kind === "identifier") {
            const entity = this.resolveEntity(expr, namespace)[0];

            if (!entity) {
                throw new Error(`${expr.label} is not defined`);
            }

            if (entity.kind === "value") return this.ir.getEntity(entity.typeEntity) as IRTypeEntity;
            return entity as IRTypeEntity;
        }

        if (expr.kind === "block-expression") {
            return this.inferType(expr.body[expr.body.length - 1], namespace);
        }

        if (expr.kind === "parameter-declaration") {
            if (expr.type) {
                return this.ir.findEntitiesWithLabel(expr.type.label, namespace)[0] as IRTypeEntity;
            }

            if (expr.initializer) {
                return this.inferType(expr.initializer, namespace);
            }
        }

        const byLabel = (label: string) => this.ir.findEntitiesWithLabel(label, namespace)[0];
        if (expr.kind === "bool-literal") return byLabel("bool") as IRTypeEntity;
        if (expr.kind === "float-literal") return byLabel("f32") as IRTypeEntity;
        if (expr.kind === "int-literal") return byLabel("i32") as IRTypeEntity;
        if (expr.kind === "return-statement") return this.inferType(expr.expression, namespace);
        if (expr.kind === "if-expression") {
            return this.inferType(expr.body[expr.body.length - 1], namespace);
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
