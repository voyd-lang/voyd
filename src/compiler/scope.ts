import { Entities } from "./entities";
import { Entity, FunctionEntity } from "./definitions";

export class Scope {
    /** entities withing this scope */
    protected readonly entities: Set<string> = new Set();

    /** All of the entities the module exports */
    readonly exports: string[] = [];

    readonly parent?: Scope;

    /** The scope allows local variables */
    isFnScope: boolean = false;

    /**
     * Defined locals in this scope. Only allowed if isMainFnScope.
     * Note: Having a local does not imply it is accessible from this scope.
     * It may have been defined in a sub scope of the function.
     */
    locals: string[] = [];

    constructor(parent?: Scope) {
        this.parent = parent;
    }

    /** Iterator of all entity IDs accessible from the scope, TODO: TRAVERSE PARENT SCOPES AND INCLUDE THEIR VALUES TOO */
    values() {
        return this.entities.values();
    }

    /** Add the entity as accessible from this scope */
    add(id: string) {
        this.entities.add(id);
    }

    /**
     * Adds the entity to the current scope, and as a local to the main function scope.
     * If we are not inside a function, throw an error.
     *
     * @param addToScope - For internal use only
     */
    addLocal(id: string, addToScope = true) {
        if (addToScope) this.add(id);

        if (this.isFnScope) {
            this.locals.push(id);
            return;
        }

        if (this.parent) {
            this.parent.addLocal(id, false);
            return;
        }

        throw new Error("Variable defined in invalid scope");
    }

    localsCount(): number {
        if (this.isFnScope) return this.locals.length;
        if (this.parent) return this.parent.localsCount();
        throw new Error("Not in a function");
    }

    export(id: string) {
        this.exports.push(id);
    }

    hasEntity(id: string): boolean {
        if (this.entities.has(id)) return true;

        if (this.parent) return this.parent.hasEntity(id);

        return false;
    }

    newSubScope(): Scope {
        return new Scope(this);
    }
}
