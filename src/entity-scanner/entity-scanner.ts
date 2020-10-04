import { AST, FunctionDeclaration, Instruction, IfExpression, ImplDeclaration, StructLiteral, VariableDeclaration } from "../parser";
import { Scope } from "../scope";
import { TypeAliasEntity } from "./definitions";

/**
 * Scans an AST for declared entities. Update AST scopes with the resolved items
 *
 * @returns a collection of all detected entities.
 *  */
export function scanForEntities(ast: AST) {
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
        instruction.id = scope.add({
            kind: "type-alias",
            label: instruction.label,
            flags: instruction.flags,
            instanceScope: scope.sub("type")
        });
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

    if (
        instruction.kind === "binary-expression" ||
        instruction.kind === "call-expression" ||
        instruction.kind === "property-access-expression"
    ) {
        instruction.arguments.forEach(instruction => scanInstruction({ scope, instruction }));
        return;
    }


    if (instruction.kind === "match-expression") {
        instruction.cases.forEach(mCase => scanInstruction({ scope, instruction: mCase.expression }));
        return;
    }

    if (instruction.kind === "struct-literal") {
        scanStructLiteral(instruction, scope);
        return;
    }
}

function scanVariableDeclaration(variable: VariableDeclaration, scope: Scope) {
    variable.id = scope.addLocal({
        kind: "variable",
        label: variable.label,
        flags: variable.flags,
        mutable: variable.flags.includes("var"),
        index: scope.localsCount(),
        tokenIndex: variable.tokenIndex
    });

    if (variable.initializer) {
        scanInstruction({ scope, instruction: variable.initializer });
    }
}

function scanStructLiteral(struct: StructLiteral, scope: Scope) {
    const fields: string[] = [];
    const instanceScope = scope.sub("type");

    for (const label in struct.fields) {
        const id = instanceScope.add({
            kind: "struct-field",
            index: fields.length,
            label,
            flags: []
        });
        scanInstruction({ scope, instruction: struct.fields[label].initializer });
        struct.fields[label].id = id;
        fields.push(id);
    }

    struct.id = scope.add({
        kind: "struct",
        label: "literal",
        fields,
        instanceScope,
        flags: []
    });
}

function scanImpl({ scope, instruction }: { scope: Scope; instruction: ImplDeclaration; }) {
    instruction.id = scope.add({ kind: "impl", flags: instruction.flags, label: instruction.target });
    const target = scope.resolveLabel(instruction.target) as TypeAliasEntity;
    instruction.functions.forEach(fn => scanFn({ fn, scope: target.instanceScope }));
}

function scanFn({ fn, scope }: { fn: FunctionDeclaration, scope: Scope }) {
    const parameters = fn.parameters.map(pd => {
        const id = fn.scope.addLocal({
            kind: "parameter",
            index: fn.scope.localsCount(),
            label: pd.label,
            flags: pd.flags,
            mutable: pd.flags.includes("var")
        });
        pd.id = id;
        return id;
    });

    fn.id = scope.add({
        kind: "function",
        flags: fn.flags,
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
