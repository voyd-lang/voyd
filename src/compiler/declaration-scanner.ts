import { Entities } from "./entities";
import { Scope } from "./scope";
import { AST, FunctionDeclaration, TypeDeclaration, Instruction, Identifier, VariableDeclaration, PropertyAccessExpression, ImplDeclaration, CallExpression, BinaryExpression, StructDeclaration, EnumDeclaration } from "../parser";
import { EntityResolver } from "./entity-resolver";

/**
 * Performs initial namespace and scoping resolution. Does not resolve function calls.
 *
 * This evolves:
 * 1. Creating entities from declarations.
 * 2. Adding entity ID's to the declaration instructions
 * 3. Resolving references to entities. I.E. adding ID's to identifiers
 * 4. Generating errors for unknown identifiers
 */
export class SemanticAnalyzer {
    private readonly entities: Entities;
    private readonly resolver: EntityResolver;

    constructor(entities: Entities) {
        this.entities = entities;
        this.resolver = new EntityResolver(entities);
    }

    analyze(ast: AST, scope: Scope) {
        for (const instruction of ast) {
            this.scanInstruction(instruction, scope);
        }
    }

    listUnresolved(): string[] {
        return this.resolver.listUnresolved();
    }

    private scanInstruction(instruction: Instruction, scope: Scope) {
        if (instruction.kind === "function-declaration") {
            this.scanFn(instruction, scope);
            return;
        }

        if (instruction.kind === "type-declaration") {
            this.scanType(instruction, scope);
            return;
        }

        if (instruction.kind === "enum-declaration") {
            this.scanType(instruction, scope);
            return;
        }

        if (instruction.kind === "struct-declaration") {
            this.scanType(instruction, scope);
            return;
        }

        if (instruction.kind === "identifier") {
            this.scanIdentifier(instruction, scope);
            return;
        }

        if (instruction.kind === "variable-declaration") {
            this.scanVariableDeclaration(instruction, scope);
            return;
        }

        if (instruction.kind === "property-access-expression") {
            this.scanPropertyAccessExpression(instruction, scope);
            return;
        }

        if (instruction.kind === "impl-declaration") {
            this.scanImplDeclaration(instruction, scope);
            return;
        }

        if (instruction.kind === "call-expression" || instruction.kind === "binary-expression") {
            this.scanCallExpression(instruction, scope);
            return;
        }

        if (instruction.kind === "block-expression") {
            instruction.body.forEach(val => this.scanInstruction(val, scope));
            return;
        }

        if (instruction.kind === "enum-variant") {

        }
    }

    private scanCallExpression(expr: CallExpression | BinaryExpression, scope: Scope) {
        for (const arg of expr.arguments) {
            this.scanInstruction(arg, scope);
        }
    }

    private scanImplDeclaration(impl: ImplDeclaration, scope: Scope) {
        this.resolver.resolveTypeEntity({
            label: impl.target,
            scope,
            resolver: type => {
                impl.targetID = type.id;
                impl.functions.forEach(fn => this.scanFn(fn, type.scope, type.id));
            }
        })
    }

    private scanPropertyAccessExpression(expr: PropertyAccessExpression, scope: Scope) {
        const walk = async (expr: PropertyAccessExpression | Identifier, scope: Scope): Promise<Scope> =>
            new Promise<Scope>(async res => {
                if (expr.kind === "identifier") {
                    return this.resolver.resolveIdentifier({
                        label: expr.label,
                        scope,
                        resolver: e => {
                            expr.id = e.id;
                            res(e.scope);
                        }
                    });
                }

                const arg2Scope = await walk(expr.arguments[0], scope);
                return walk(expr.arguments[1], arg2Scope);
            });

        walk(expr, scope);
    }

    private scanVariableDeclaration(vr: VariableDeclaration, scope: Scope) {
        if (vr.initializer) this.scanInstruction(vr.initializer, scope);

        const id = this.entities.add({
            kind: "local",
            label: vr.label,
            flags: vr.flags,
            mutable: vr.flags.includes("var"),
            scope,
            index: scope.localsCount() + 1
        });

        scope.addLocal(id);
        vr.id = id;
    }

    private scanIdentifier(ident: Identifier, scope: Scope) {
        this.resolver.resolveIdentifier({
            label: ident.label, scope,
            resolver: e => ident.id = e.id
        });
    }

    private scanType(type: TypeDeclaration | StructDeclaration | EnumDeclaration, scope: Scope) {
        const id = this.entities.add({
            kind: "type",
            label: type.label,
            flags: type.flags,
            // TODO distinguish static and instance namespaces
            scope: scope.newSubScope(),
        });
        scope.add(id);
        if (type.flags.includes("pub")) scope.export(id);
        type.id = id;
    }

    private scanFn(fn: FunctionDeclaration, outerScope: Scope, self?: string) {
        const fnScope = outerScope.newSubScope();
        fnScope.isFnScope = true;
        const id = this.entities.add({
            kind: "function",
            parameters: [],
            label: fn.label,
            flags: fn.flags,
            scope: fnScope
        });

        fn.id = id;
        outerScope.add(id);
        this.resolveFnParameters(fn, fnScope, self);

        if (fn.flags.includes("pub")) outerScope.export(id);
        if (fn.expression) this.scanInstruction(fn.expression, fnScope);
        if (fn.returnType) {
            this.resolver.resolveTypeEntity({
                scope: outerScope,
                label: fn.returnType.label,
                resolver: (e) => this.entities.update({ id, returnType: e.id })
            });
        }
    }

    private resolveFnParameters(fn: FunctionDeclaration, fnScope: Scope, self?: string) {
        const parameters: string[] = [];

        if (self) {
            const paramID = this.entities.add({
                kind: "local",
                label: "self",
                flags: [],
                scope: fnScope,
                typeEntity: self,
                index: 0,
                mutable: fn.flags.includes("mut")
            });

            fnScope.add(paramID);
            parameters.push(paramID);
        }

        fn.parameters.forEach(p => {
            const id = this.entities.add({
                kind: "local",
                flags: [],
                label: p.label,
                scope: fnScope,
                mutable: false,
                index: parameters.length
            });

            this.resolver.resolveTypeEntity({
                label: p.type!.label,
                scope: fnScope,
                resolver: entity => this.entities.update({ id, typeEntity: entity.id })
            });

            fnScope.add(id);
            parameters.push(id);
        });

        return parameters;
    }
}
