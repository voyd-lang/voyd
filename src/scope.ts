import { Entity, EntityKind, NewEntity } from "./entity-scanner/definitions";
import uniqid from "uniqid";

export class Scope {
    /** Entities within this scope */
    private readonly entities: Map<string, Entity>;

    /** The scope allows local variables */
    isFnScope: boolean = false;

    /**
     * Defined locals in this scope. Only allowed if isMainFnScope.
     * Note: Having a local does not imply it is accessible from this scope.
     * It may have been defined in a sub scope of the function.
     */
    locals: string[] = [];

    constructor(parent?: Scope, entities?: Map<string, Entity>) {
        this.entities = entities ?? new Map();
        this.parent = parent;
    }

    entitiesWithLabel(label: string, found: AccessibleEntities = [], depth = 0): AccessibleEntities {
        for (const entity of this.entities.values()) {
            if (entity.label === label) found.push({ entity, depth });
        }

        if (this.parent) return this.parent.entitiesWithLabel(label, found, depth + 1);

        return found;
    }

    closestEntityWithLabel(label: string, includedKinds: EntityKind[]): Entity | undefined {
        for (const entity of this.entities.values()) {
            if (entity.label && includedKinds.includes(entity.kind)) return entity;
        }

        if (this.parent) return this.parent.closestEntityWithLabel(label, includedKinds);

        return undefined;
    }

    /** Add the entity as accessible from this scope */
    add(entity: NewEntity) {
        const id = uniqid();
        this.entities.set(id, { id, ...entity });
        return id;
    }

    /**
     * Adds the entity to the current scope, and as a local to the main function scope.
     * If we are not inside a function, throw an error.

     */
    addLocal(entity: NewEntity) {
        const id = this.add(entity);
        this.addEntityIDToFnLocals(id);
        return id;
    }

    protected addEntityIDToFnLocals(id: string) {
        if (this.isFnScope) {
            this.locals.push(id);
            return;
        }

        if (this.parent) {
            this.parent.addEntityIDToFnLocals(id);
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

    canAccessEntity(id: string): boolean {
        if (this.entities.has(id)) return true;

        if (this.parent) return this.parent.canAccessEntity(id);

        return false;
    }

    sub(): Scope {
        return new Scope(this);
    }

    toJSON() {
        return {
            // When available, this should be translated to Object.fromEntries(this.entities.entries)
            entities: Array.from(this.entities.entries()).reduce((obj, [id, entity]) => {
                obj[id] = entity;
                return obj;
            }, {} as Record<string, Entity>),
            exports: this.exports,
            isFnScope: this.isFnScope,
            locals: this.locals
        };
    }
}

/** Represents all entities within the scope. A depth of 0 represents the current scope, each scope above adds 1 */
export type AccessibleEntities = { entity: Entity, depth: number }[];

export type AccessLevel = "private" | "protected"
