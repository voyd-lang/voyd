import { Instruction, AST, FunctionDeclaration, VariableDeclaration, MatchExpression, CallExpression, BinaryExpression, Identifier, PropertyAccessExpression } from "../parser";
import { IRInstruction, IREntity, IRMatchCase, IRFunctionWASMType, IRFunctionEntity, IRValueEntity, IRTypeEntity, WASMType } from "./definitions";
import uniqid from "uniqid";
import { IR } from "./ir";

export class DIRCompiler {
    private ir = new IR();
    private moduleNamespace = this.ir.newNamespace();

    compile(ast: AST) {
        for (const instruction of ast) {
            if (instruction.kind === "function-declaration") {
                const id = this.compileFunction(instruction, this.moduleNamespace);
                const entity = this.ir.getEntity(id);
                console.dir(entity, { depth: 10 });
                continue;
            }
        }
    }

    /** Returns the ID of the function entity */
    private compileFunction(fn: FunctionDeclaration, namespace: string): string {
        const label = fn.label;
        const fnNamespace = this.ir.newNamespace(namespace);
        const body: IRInstruction[] = [];
        const locals: string[] = [];
        const parameters = this.compileFunctionParameters(fn, fnNamespace);
        const { returnType, returnWASMType } = this.compileFunctionReturnType(fn, fnNamespace);

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

        // Build the function body
        body.push(...this.compileBlock(fn.body, locals, fnNamespace));

        // Generate the WASMType for the function
        const wasmType: IRFunctionWASMType =
            this.compileFnWASMType(parameters, locals, returnWASMType);

        this.ir.updateFunction(id, { locals, body, wasmType });

        if (fn.flags.includes("pub")) this.ir.exportEntity(id);

        return id;
    }

    private compileFnWASMType(parameters: never[], locals: string[], returnWASMType: WASMType): IRFunctionWASMType {
        return {
            kind: "function",
            id: uniqid(),
            parameters: parameters
                .map(id => this.ir.getEntity(id).wasmType)
                .filter(e => !!e) as WASMType[],
            locals: locals
                .map(id => this.ir.getEntity(id).wasmType)
                .filter(e => !!e) as WASMType[],
            returnType: returnWASMType
        };
    }

    private compileFunctionReturnType(fn: FunctionDeclaration, internalNamespace: string): {
        returnType: string,
        returnWASMType: WASMType
    } {
        const typeEntity = fn.returnType ?
            this.ir.findEntitiesWithLabel(fn.returnType.label, internalNamespace)[0] :
            this.inferType(fn.body[fn.body.length - 1], internalNamespace);

        if (!typeEntity || typeEntity.kind !== "type") {
            throw new Error(`${typeEntity.label} is not a type`);
        }

        if (!typeEntity.wasmType) {
            throw new Error(`The return type of ${fn.label} could not be inferred`);
        }

        return { returnType: typeEntity.id, returnWASMType: typeEntity.wasmType };
    }

    private compileFunctionParameters(fn: FunctionDeclaration, internalNamespace: string) {
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
                wasmType: typeEntity.wasmType,
                namespace: internalNamespace,
                typeEntity: typeEntity.id
            }, internalNamespace);

            parameters.push(paramID);
        });

        return [];
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
            return this.compileCallExpression(expr, namespace, locals);
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
                this.ir.findEntitiesWithLabel(expr.calleeLabel, namespace)
        ).filter(v => v.kind === "function") as IRFunctionEntity[];

        if (entities.length === 0) throw new Error(`No function found for ${findLabelForCall(expr)}`);

        for (const entity of entities) {
            const signatureMatches = entity.parameters.every((paramEntityID, index) => {
                const argExpr = expr.arguments[index];
                if (!argExpr) return false;

                const typeID = this.inferType(argExpr, namespace).id;

                // TODO: This is wrong, val is the parameter entity ID, not the type ID of the parameter
                return typeID === (this.ir.getEntity(paramEntityID) as IRValueEntity).typeEntity;
            });
            if (signatureMatches) return entity;
        }

        throw new Error(`No function found for ${findLabelForCall(expr)}`);
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
            wasmType: typeEntity.wasmType,
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
            if (entity.kind !== "function") throw new Error(`${findLabelForCall(expr)} is not a function.`);
            const returnType = (entity as IRFunctionEntity).returnType;
            if (returnType) return this.ir.getEntity(returnType) as IRTypeEntity;
        }

        if (expr.kind === "binary-expression") {
            const entity = this.ir.findEntitiesWithLabel(expr.calleeLabel, namespace)[0];
            if (entity.kind !== "function") throw new Error(`${findLabelForCall(expr)} is not a function.`);
            const returnType = (entity as IRFunctionEntity).returnType;
            if (returnType) return this.ir.getEntity(returnType) as IRTypeEntity;
        }

        if (expr.kind === "identifier") {
            const entity = this.resolveEntity(expr, namespace)[0];
            if (entity.kind === "value") return this.ir.getEntity(entity.typeEntity) as IRTypeEntity;
            return entity as IRTypeEntity;
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


        console.dir(expr);
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
