import { AST, FunctionDeclaration, Instruction, IfExpression, ImplDeclaration, Identifier, VariableDeclaration } from "./parser";
import { Scope } from "./scope";
import { FunctionEntity, ParameterEntity, TypeAlias, VariableEntity } from "./entity-scanner";

/** Enforces scoping rules, resolves identifiers and infers types. */
export function analyseSemantics(ast: AST) {
    scanBlock(ast);
}

function scanBlock({ body, scope }: { body: Instruction[]; scope: Scope; }) {
    for (const instruction of body) {
        scanInstruction({ instruction, scope });
    }
}

function scanInstruction({ scope, instruction }: { scope: Scope, instruction: Instruction }) {
    if (instruction.kind === "block-expression") {
        scanBlock({ body: instruction.body, scope: instruction.scope });
        return;
    }

    if (instruction.kind === "impl-declaration") {
        scanImpl({ scope, instruction });
        return;
    }

    if (instruction.kind === "variable-declaration") {
        scanVariableDeclaration(instruction, scope);
        return;
    }

    if (instruction.kind === "function-declaration") {
        scanFn(instruction, scope);
        return;
    }

    if (instruction.kind === "if-expression") {
        scanIf({ dif: instruction, scope });
        return;
    }

    if (instruction.kind === "while-statement") {
        scanBlock({ body: instruction.body, scope });
        scanInstruction({ instruction: instruction.condition, scope });
        return;
    }

    if (instruction.kind === "identifier") {
        const entity = scope.closestEntityWithLabel(instruction.label, ["function", "parameter", "variable", "type-alias"]);
        if (!entity) throw new Error(`No entity with label ${instruction.label} in current scope.`);
        if (entity.kind === "variable" && instruction.tokenIndex < entity.tokenIndex) {
            throw new Error(`Identifier ${instruction.label} used before defined`);
        }
        instruction.id = entity.id;
    }

    if (instruction.kind === "binary-expression") {
        instruction.arguments.forEach(instruction => scanInstruction({ scope, instruction }));
        const typeEntityId = typeEntityIdOfExpression(instruction.arguments[0], scope);
        const typeEntity = scope.get(typeEntityId) as TypeAlias;
        const func = typeEntity.instanceScope.closestEntityWithLabel(instruction.calleeLabel, ["function"]);
        if (!func) throw new Error(`${instruction.calleeLabel} is not a function`);
        instruction.calleeId = func.id;
        return;
    }

    if (instruction.kind === "call-expression") {
        instruction.arguments.forEach(instruction => scanInstruction({ scope, instruction }));
        const label = (instruction.callee as Identifier).label;
        const func = scope.closestEntityWithLabel(label, ["function"]);
        if (!func) throw new Error(`${label} is not a function`);
        instruction.calleeId = func.id;
        return;
    }

    if (instruction.kind === "match-expression") {
        instruction.cases.forEach(mCase => scanInstruction({ scope, instruction: mCase.expression }));
        return;
    }

    if (instruction.kind === "assignment") {
        scanInstruction({ scope, instruction: instruction.assignee });
        scanInstruction({ scope, instruction: instruction.expression });
    }
}

function scanVariableDeclaration(expr: VariableDeclaration, scope: Scope) {
    const varEntity = scope.get(expr.id!) as VariableEntity;
    if (expr.initializer) scanInstruction({ scope, instruction: expr.initializer });
    if (expr.type) {
        const typeEntity = scope.closestEntityWithLabel(expr.type.label, ["type-alias"]);
        if (!typeEntity) throw new Error(`Could not resolve type for ${expr.label}`);
        varEntity.typeEntity = typeEntity;
        varEntity.typeLabel = typeEntity.label;
    } else if (expr.initializer) {
        const typeEntityId = typeEntityIdOfExpression(expr.initializer, scope);
        const typeEntity = scope.get(typeEntityId) as TypeAlias;
        varEntity.typeEntity = typeEntity;
        varEntity.typeLabel = typeEntity.label;
    } else {
        throw new Error(`Could not resolve type for ${expr.label}`);
    }
}

function scanImpl({ scope, instruction }: { scope: Scope; instruction: ImplDeclaration; }) {
    instruction.id = scope.add({ kind: "impl", flags: instruction.flags, label: instruction.target });
    const target = scope.closestEntityWithLabel(instruction.target, ["type-alias"]) as TypeAlias;
    instruction.functions.forEach(fn => scanFn(fn, target.instanceScope));
}

function scanFn(fn: FunctionDeclaration, scope: Scope) {
    const fnEntity = scope.get(fn.id!) as FunctionEntity;

    if (fn.returnType) {
        const typeEntity = scope.closestEntityWithLabel(fn.returnType.label, ["type-alias"]);
        fnEntity.returnTypeEntity = typeEntity;
        fnEntity.returnTypeLabel = typeEntity?.label;
    }

    fn.parameters.forEach(p => {
        const pEntity = scope.get(p.id!) as ParameterEntity;
        if (p.type) {
            const typeEntity = scope.closestEntityWithLabel(p.type.label, ["type-alias"]);
            if (!typeEntity) throw new Error(`Cannot resolve type for ${p.label} of ${fn.label}.`);
            pEntity.typeEntity = typeEntity;
            pEntity.typeLabel = typeEntity.label;
            return;
        }

        if (p.initializer) {
            const typeEntityId = typeEntityIdOfExpression(p.initializer, scope);
            const typeEntity = scope.get(typeEntityId)!;
            pEntity.typeEntity = typeEntity;
            pEntity.typeLabel = typeEntity.label;
            return;
        }

        throw new Error(`Missing type for parameter ${p.label} of ${fn.label}`);
    });

    if (fn.expression) scanInstruction({ scope: fn.scope, instruction: fn.expression });

    if (!fn.returnType && fn.expression) {
        const typeEntityId = typeEntityIdOfExpression(fn.expression, fn.scope);
        const typeEntity = fn.scope.get(typeEntityId)!;
        fnEntity.returnTypeEntity = typeEntity;
        fnEntity.returnTypeLabel = typeEntity.label;
    } else if (!fn.returnType && !fn.expression) {
        throw new Error(`Missing return type for ${fnEntity.label}`);
    }
}

function scanIf({ dif, scope }: { dif: IfExpression; scope: Scope; }) {
    scanInstruction({ instruction: dif.condition, scope });
    scanBlock({ body: dif.body, scope: dif.scope });
    dif.elifs.forEach(({ condition, body, scope: elifScope }) => {
        scanInstruction({ instruction: condition, scope });
        scanBlock({ body, scope: elifScope });
    });
    if (dif.else) {
        scanBlock({ body: dif.else.body, scope: dif.else.scope });
    }
}

function typeEntityIdOfExpression(expr: Instruction, scope: Scope): string {
    if (expr.kind === "identifier") {
        const entity = scope.closestEntityWithLabel(expr.label, ["type-alias", "parameter", "variable"]);
        if (!entity) throw new Error(`Unknown identifier ${expr.label}`);
        if (entity.kind === "type-alias") return entity.id;
        return ((entity as (ParameterEntity | VariableEntity)).typeEntity!.id);
    }

    if (expr.kind === "block-expression") {
        return typeEntityIdOfExpression(expr.body[expr.body.length - 1], expr.scope);
    }

    if (expr.kind === "call-expression") {
        if (!expr.calleeId) throw new Error(`Function not yet resolved for ${expr.callee}`);
        const fnEntity = scope.get(expr.calleeId) as FunctionEntity;
        if (!fnEntity.returnTypeEntity) throw new Error(`Return type not yet resolved for ${fnEntity.label}`);
        return fnEntity.returnTypeEntity.id;
    }

    if (expr.kind === "binary-expression") {
        if (!expr.calleeId) throw new Error(`Function not yet resolved for ${expr.calleeLabel}`);
        const fnEntity = scope.get(expr.calleeId) as FunctionEntity;
        if (!fnEntity.returnTypeEntity) throw new Error(`Return type not yet resolved for ${fnEntity.label}`);
        return fnEntity.returnTypeEntity.id;
    }

    if (expr.kind === "if-expression") {
        return typeEntityIdOfExpression(expr.body[expr.body.length], scope);
    }

    if (expr.kind === "int-literal") {
        const i32Entity = scope.closestEntityWithLabel("i32", ["type-alias"]);
        if (!i32Entity) throw new Error("Uh oh. i32 entity not found. Bad compiler! BAD!");
        return i32Entity.id;
    }

    const voidEntity = scope.closestEntityWithLabel("Void", ["type-alias"]);
    if (!voidEntity) throw new Error("Uh oh. Void entity not found. Bad compiler! BAD!");
    return voidEntity.id;
}
