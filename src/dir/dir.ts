import { Instruction, AST, MethodDeclaration, VariableDeclaration, MatchExpression, CallExpression, BinaryExpression } from "../parser";
import { IRInstruction, IREntity, IRMatchCase, IRFunctionWASMType, IRFunctionEntity, IRValueEntity, IRTypeEntity } from "./definitions";
import uniqid from "uniqid";
import { IR } from "./ir";

export class DIRCompiler {
    private ir = new IR();
    private moduleNamespace = this.ir.newNamespace();


    compile(ast: AST) {
        for (const instruction of ast) {
            if (instruction.kind === "method-declaration") {
                const id = this.compileFunction(instruction, this.moduleNamespace);
                const entity = this.ir.getEntity(id, this.moduleNamespace);
                console.dir(entity, { depth: 10 });
                continue;
            }
        }
    }

    /** Returns the ID of the function entity */
    private compileFunction(method: MethodDeclaration, namespace: string): string {
        const label = method.label;
        const internalNamespace = this.ir.newNamespace(namespace);
        const body: IRInstruction[] = [];
        const locals: string[] = [];
        const parameters: string[] = [];

        // Resolve method parameters.
        method.parameters.forEach(p => {
            const typeEntity = this.ir.findEntityByLabel(label, internalNamespace);
            if (typeEntity.kind !== "type") throw new Error(`${typeEntity.label} is not a type`);
            const paramID = this.ir.addEntity({
                kind: "value",
                flags: [],
                label: p.label,
                wasmType: typeEntity.wasmType,
                namespace: internalNamespace,
                typeEntity: typeEntity.id
            });
            parameters.push(paramID);
        });

        // Resolve return type entity, generate returnWASMType type.
        const { returnType, returnWASMType } = (() => {
            const typeEntity = method.returnType ? this.ir.findEntityByLabel(method.returnType.label, internalNamespace) :
                this.inferType(method.body[method.body.length - 1], internalNamespace);
            if (typeEntity.kind !== "type") throw new Error(`${typeEntity.label} is not a type`);
            return { returnType: typeEntity.id, returnWASMType: typeEntity.wasmType };
        })()

        // Build the function body
        body.push(...this.compileBlock(method.body, locals, internalNamespace));

        // Generate the WASMType for the function
        const wasmType: IRFunctionWASMType = {
            kind: "function",
            id: uniqid(),
            parameters: parameters.map(id => this.ir.getEntity(id, internalNamespace).wasmType),
            locals: locals.map(id => this.ir.getEntity(id, internalNamespace).wasmType),
            returnType: returnWASMType
        };

        // Create the function entity
        const id = this.ir.addEntity({
            kind: "function",
            label,
            flags: method.flags,
            body,
            parameters,
            locals,
            namespace: internalNamespace,
            returnType,
            wasmType: wasmType,
        }, namespace);

        if (method.flags.includes("pub")) this.ir.exportEntity(id);

        return id;
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

        if (expr.kind === "call-expression" || expr.kind === "binary-expression") {
            const func = this.findCalleeFunctionEntity(expr, namespace);
            return {
                kind: "call-expression",
                calleeID: func.id,
                calleeLabel: expr.calleeLabel,
                arguments: expr.arguments.map(arg => this.compileExpression(arg, locals, namespace)),
                returnType: func.returnType
            }
        }

        if (expr.kind === "break-statement") return { kind: "break-statement" };
        if (expr.kind === "continue-statement") return { kind: "continue-statement" };
        if (expr.kind === "return-statement") {
            return {
                kind: "return-statement",
                expression: this.compileExpression(expr, locals, namespace)
            }
        }

        if (expr.kind === "assignment") {
            return {
                kind: "assignment",
                assigneeEntityID: this.ir.findEntityByLabel(expr.assigneeLabel, namespace).id,
                label: expr.assigneeLabel,
                expression: this.compileExpression(expr.expression, locals, namespace)
            }
        }

        if (expr.kind === "identifier") {
            const identifierEntity = this.ir.findEntityByLabel(expr.label, namespace);
            return {
                kind: "identifier",
                identifierEntityID: identifierEntity.id,
                label: expr.label,
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

    private findCalleeFunctionEntity(expr: CallExpression | BinaryExpression, namespace: string): IRFunctionEntity {
        const entities = this.ir.findFunctionsWithLabel(expr.calleeLabel, namespace);
        if (!entities) throw new Error(`No function found for ${expr.calleeLabel}`);

        for (const entity of entities) {
            const signatureMatches = entity.parameters.every((paramEntityID, index) => {
                const argExpr = expr.arguments[index];
                if (!argExpr) return false;
                // TODO: Some of the types the function uses might not be in the current namespace, but are still valid.
                const typeID = this.inferType(argExpr, namespace).id;
                // TODO: This is wrong, val is the parameter entity ID, not the type ID of the parameter
                return typeID === (this.ir.getEntity(paramEntityID, namespace) as IRValueEntity).typeEntity;
            });
            if (signatureMatches) return entity;
        }

        throw new Error(`No function found for ${expr.calleeLabel}`);
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
            wasmType: typeEntity.wasmType,
            namespace
        }
    }

    private getVariableTypeEntity(variable: VariableDeclaration, namespace: string): IRTypeEntity {
        if (variable.type) {
            const type = this.ir.findEntityByLabel(variable.type.label, namespace);
            if (type.kind !== "type") throw new Error(`${variable.type.label} is not a type`);
            return type as IRTypeEntity;
        }

        if (!variable.initializer) throw new Error(`Missing type for ${variable.label}`);
        return this.inferType(variable.initializer, namespace);
    }

    /** Returns the expression's result type entity, TODO: ADD ERROR CHECKING IN PLACE OF AS IRTypeEntity */
    private inferType(expr: Instruction, namespace: string): IRTypeEntity {
        if (expr.kind === "call-expression" || expr.kind === "binary-expression") {
            const entity = this.ir.findEntityByLabel(expr.calleeLabel, namespace);
            if (entity.kind !== "function") throw new Error(`${expr.calleeLabel} is not a function.`);
            return this.ir.getEntity((entity as IRFunctionEntity).returnType, namespace) as IRTypeEntity;
        }

        if (expr.kind === "identifier") {
            const entity = this.ir.findEntityByLabel(expr.label, namespace);
            if (entity.kind === "value") return this.ir.getEntity(entity.typeEntity, namespace) as IRTypeEntity;
            return entity as IRTypeEntity;
        }

        const byLabel = (label: string) => this.ir.findEntityByLabel(label, namespace);
        if (expr.kind === "bool-literal") return byLabel("bool") as IRTypeEntity;
        if (expr.kind === "float-literal") return byLabel("f32") as IRTypeEntity;
        if (expr.kind === "int-literal") return byLabel("i32") as IRTypeEntity;
        if (expr.kind === "return-statement") return this.inferType(expr.expression, namespace);
        if (expr.kind === "if-expression") {
            return this.inferType(expr.body[expr.body.length - 1], namespace);
        }


        console.dir(expr);
        throw new Error(`Unable to infer type`);
    }
}
