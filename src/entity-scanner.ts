import { AST, FunctionDeclaration, Instruction, IfExpression, ImplDeclaration } from "./parser";
import { Scope } from "./scope";

/**
 * Scans an AST for declared entities. Update AST scopes with the resolved items
 *
 * @returns a collection of all detected entities.
 *  */
export function entityScanner(ast: AST) {
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

    if (instruction.kind === "type-declaration") {
        instruction.id =
            scope.add({ kind: "type-alias", label: instruction.label, flags: instruction.flags });
        return;
    }

    if (instruction.kind === "impl-declaration") {
        scanImpl({ scope, instruction });
        return;
    }

    if (instruction.kind === "variable-declaration") {
        instruction.id = scope.addLocal({
            kind: "variable",
            label: instruction.label,
            flags: instruction.flags,
            mutable: instruction.flags.includes("var"),
            typeLabel: instruction.type ? instruction.type.label : undefined,
            typeEntity: instruction.type ? scope.closestEntityWithLabel(instruction.type.label, ["type-alias"]) : undefined,
            index: scope.localsCount()
        });
        return;
    }

    if (instruction.kind === "function-declaration") {
        scanFn({ fn: instruction, scope });
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

    if (instruction.kind === "binary-expression" || instruction.kind === "call-expression") {
        instruction.arguments.forEach(instruction => scanInstruction({ scope, instruction }));
        return;
    }

    if (instruction.kind === "match-expression") {
        instruction.cases.forEach(mCase => scanInstruction({ scope, instruction: mCase.expression }));
        return;
    }
}

function scanImpl({ scope, instruction }: { scope: Scope; instruction: ImplDeclaration; }) {
    instruction.id = scope.add({ kind: "impl", flags: instruction.flags, label: instruction.target });
    scanBlock({ body: instruction.functions, scope: instruction.scope });
}

function scanFn({ fn, scope }: { fn: FunctionDeclaration, scope: Scope }) {
    fn.scope.isFnScope = true;
    const parameters = fn.parameters.map(pd => fn.scope.addLocal({
        kind: "parameter",
        index: fn.scope.localsCount(),
        label: pd.label,
        flags: pd.flags,
        typeLabel: pd.type ? pd.type.label : undefined,
        typeEntity: pd.type ? scope.closestEntityWithLabel(pd.type.label, ["type-alias"]) : undefined,
        mutable: pd.flags.includes("var")
    }));

    fn.id = scope.add({
        kind: "function",
        flags: fn.flags,
        returnTypeLabel: fn.returnType ?
            fn.returnType.label : undefined,
        returnTypeEntity: fn.returnType ?
            scope.closestEntityWithLabel(fn.returnType.label, ["type-alias"]) : undefined,
        parameters,
        label: fn.label
    });

    if (fn.expression) scanInstruction({ scope: fn.scope, instruction: fn.expression });
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
