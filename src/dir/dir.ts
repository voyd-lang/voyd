import { Instruction, AST, MethodDeclaration, VariableDeclaration, MatchExpression, CallExpression, BinaryExpression } from "../parser";
import { IR, IRInstruction, IRMethodDef, IRVariableDef, IRNamespace, IREntity, IRMatchCase, IRBlockContext } from "./definitions";
import uniqid from "uniqid";

export function dir(ast: AST): IR {
    const ir = genEmptyIR();

    for (const instruction of ast) {
        if (instruction.kind === "method-declaration") {
            genMethodIR(instruction, ir);
            continue;
        }
    }

    return ir;
}

function genMethodIR(method: MethodDeclaration, ir: IR): { method: IRMethodDef, entities: IREntity[] } {
    const id = uniqid();
    const label = method.label;
    const namespace = genNamespace(ir.namespace);
    const body: IRInstruction[] = [];
    const entities: IREntity[] = [];
    const parameterTypes: string[] = [];
    const ctx: IRBlockContext = {
        ir, namespace, entities, body
    };

    // TODO
    method.parameters.forEach(p => {
        const type = findEntityIDByLabel(p.label, ctx);
    });

    body.push(...genBody(method.body, ctx));

    // TODO WASMType
    return {
        entities, method: {
            kind: "method",
            id, label, flags: method.flags,
            body, namespace, parameterTypes
        }
    };
}

function genBody(instructions: Instruction[], ctx: IRBlockContext): IRInstruction[] {
    return instructions.map(instruction => {
        if (instruction.kind === "variable-declaration") {
            assertLabelNotTaken(instruction, ctx.namespace);
            const variable = genVariableIR(instruction, ctx);
            ctx.entities.push(variable);
            ctx.namespace.labels.add(variable.label);
            ctx.namespace.entities.add(variable.id);
            if (instruction.initializer) {
                ctx.body.push({
                    kind: "assignment",
                    id: variable.id,
                    label: variable.label,
                    expression: genExpressionIR(instruction.initializer, ctx)
                });
            }
        }

        return genExpressionIR(instruction, ctx);
    })
}

function genExpressionIR(expr: Instruction, ctx: IRBlockContext): IRInstruction {
    if (expr.kind === "if-expression") {
        const ifNamespace = genNamespace(ctx.namespace);
        return {
            kind: "if-expression",
            returnType: inferType(expr.body[expr.body.length - 1], ctx),
            condition: genExpressionIR(expr.condition, ctx),
            body: genBody(expr.body, { ...ctx, namespace: ifNamespace }),
            namespace: ifNamespace
        }
    }

    if (expr.kind === "match-expression") {
        return {
            kind: "match-expression",
            value: genExpressionIR(expr.value, ctx),
            valueType: inferType(expr.value, ctx),
            returnType: inferType(expr.cases[expr.cases.length - 1].expression, ctx),
            cases: genMatchCases(expr, ctx),
            flags: []
        }
    }

    if (expr.kind === "call-expression" || expr.kind === "binary-expression") {
        const calleeID = findCalleeID(expr, ctx);
        return {
            kind: "call-expression",
            calleeID,
            calleeLabel: expr.calleeLabel,
            arguments: expr.arguments.map(arg => genExpressionIR(arg, ctx)),
            returnType: (ctx.ir.entities[calleeID] as IRMethodDef).returnType
        }
    }

    if (expr.kind === "break-statement") return { kind: "break-statement" };
    if (expr.kind === "continue-statement") return { kind: "continue-statement" };
    if (expr.kind === "return-statement") {
        return {
            kind: "return-statement",
            expression: genExpressionIR(expr, ctx)
        }
    }

    if (expr.kind === "assignment") {
        return {
            kind: "assignment",
            id: findEntityIDByLabel(expr.assigneeLabel, ctx),
            label: expr.assigneeLabel,
            expression: genExpressionIR(expr.expression, ctx)
        }
    }

    if (expr.kind === "identifier") {
        const id = findEntityIDByLabel(expr.label, ctx);
        return {
            kind: "identifier",
            id,
            label: expr.label,
        }
    }

    if (expr.kind === "bool-literal") return expr;
    if (expr.kind === "string-literal") return expr;
    if (expr.kind === "float-literal") return expr;
    if (expr.kind === "int-literal") return expr;

    if (expr.kind === "while-statement") {
        const whileNamespace = genNamespace(ctx.namespace);
        return {
            kind: "while-statement",
            condition: genExpressionIR(expr.condition, ctx),
            body: genBody(expr.body, { ...ctx, namespace: whileNamespace }),
            namespace: whileNamespace
        }
    }

    throw new Error(`ASTNode, ${expr.kind}, cannot be converted to an instruction`);
}

function findCalleeID(expr: CallExpression | BinaryExpression, ctx: IRBlockContext): string {
    const entities = ctx.ir.entitiesByLabel[expr.calleeLabel];
    if (!entities) throw new Error(`No method found for ${expr.calleeLabel}`);

    for (const entityID of entities.keys()) {
        const entity = ctx.ir.entities[entityID] as IRMethodDef;
        const signatureMatches = entity.parameterTypes.every((val, index) => {
            const argExpr = expr.arguments[index];
            if (!argExpr) return false;
            const typeID = inferType(argExpr, ctx);
            return typeID === val;
        });
        if (signatureMatches) return entity.id;
    }

    throw new Error(`No method found for ${expr.calleeLabel}`);
}

function genMatchCases(expr: MatchExpression, ctx: IRBlockContext): IRMatchCase[] {
    return expr.cases.map(mCase => ({
        kind: "match-case",
        case: genExpressionIR(mCase.case, ctx),
        expression: genExpressionIR(mCase.expression, ctx)
    }));
}

function genVariableIR(variable: VariableDeclaration, ctx: IRBlockContext): IRVariableDef {
    const id = uniqid();
    const label = variable.label;
    const mutable = variable.flags.includes("var");
    const type = getVariableTypeID(variable, ctx);
    const typeEntity = ctx.ir.entities[type];

    return {
        kind: "variable",
        id, label, mutable, type,
        flags: variable.flags,
        wasmType: typeEntity.wasmType
    }
}

function getVariableTypeID(variable: VariableDeclaration, ctx: IRBlockContext): string {
    if (variable.type) {
        const type = findEntityIDByLabel(variable.type.label, ctx);
        return type;
    }

    if (!variable.initializer) throw new Error(`Missing type for ${variable.label}`);
    return inferType(variable.initializer, ctx);
}

function inferType(expr: Instruction, ctx: IRBlockContext): string {
    if (expr.kind === "call-expression" || expr.kind === "binary-expression") {
        const entityID = findEntityIDByLabel(expr.calleeLabel, ctx);
        const entity = ctx.ir.entities[entityID];
        if (entity.kind !== "method") throw new Error(`${expr.calleeLabel} is not a method or function.`);
        return (entity as IRMethodDef).returnType;
    }

    if (expr.kind === "identifier") {
        const entityID = findEntityIDByLabel(expr.label, ctx);
        const entity = ctx.ir.entities[entityID];
        return findTypeEntityIDOfEntity(entity);
    }

    const byLabel = (label: string) => findEntityIDByLabel(label, ctx);
    if (expr.kind === "bool-literal") return byLabel("bool");
    if (expr.kind === "float-literal") return byLabel("f32");
    if (expr.kind === "int-literal") return byLabel("i32");
    if (expr.kind === "return-statement") return inferType(expr.expression, ctx);
    if (expr.kind === "if-expression") {
        return inferType(expr.body[expr.body.length - 1], ctx);
    }


    console.dir(expr);
    throw new Error(`Unable to infer type`);
}

/** Need a better name, finds the entity that represents the type of another */
function findTypeEntityIDOfEntity(entity: IREntity): string {
    if (entity.kind === "variable") return entity.type;

    if (entity.isType) {
        throw new Error("Cannot assign variables to a type yet");
    }

    if (entity.kind === "method") throw new Error("Cannot alias methods just yet");

    return entity.parent;
}

/**
 * Find an entity ID by it's label
 *
 * Does not work for methods as they can be overloaded.
 * Should probably in the future work against generics. Which might mean it generates things.
 */
function findEntityIDByLabel(label: string, ctx: IRBlockContext): string {
    const entities = ctx.ir.entitiesByLabel[label];
    if (!entities) throw new Error(`Unrecognized label: ${label}`);;

    for (const [id] of entities.entries()) {
        if (ctx.namespace.entities.has(id)) return id;
    }

    throw new Error(`Unrecognized label: ${label}`);
}

function genEmptyIR(): IR {
    return {
        entities: {},
        exports: new Set(),
        functions: new Set(),
        entitiesByLabel: {},
        wasmTypes: {},
        namespace: genNamespace()
    }
}

function genNamespace(parent?: IRNamespace): IRNamespace {
    return {
        entities: new Set(parent ? parent.entities : []),
        labels: new Set(parent ? parent.entities : [])
    }
}

function assertLabelNotTaken(
    instruction: {
        label: string
        [otherStuff: string]: any
    },
    namespace: IRNamespace
) {
    if (namespace.labels.has(instruction.label)) {
        throw new Error(`Label, ${instruction.label}, already taken in this scope`);
    }
}
