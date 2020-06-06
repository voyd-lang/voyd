import { IREntity } from "./definitions";
import { IREntities } from "./entities";

export class IRScope {
    /** entities withing this scope */
    protected readonly entities: Set<string> = new Set();

    /** All of the entities the module exports */
    readonly exports: string[] = [];

    readonly parent?: IRScope;

    constructor(parent?: IRScope) {
        this.parent = parent;
    }

    /** Iterator of all entity IDs accessible from the scope, TODO: TRAVERSE PARENT SCOPES AND INCLUDE THEIR VALUES TOO */
    values() {
        return this.entities.values();
    }

    add(id: string) {
        this.entities.add(id);
    }

    export(id: string) {
        this.exports.push(id);
    }

    hasEntity(id: string): boolean {
        if (this.entities.has(id)) return true;

        if (this.parent) return this.parent.hasEntity(id);

        return false;
    }

    accessibleEntitiesWithLabel(
        label: string,
        entities: IREntities,

        /** @private */
        found: IREntity[] = []
    ): IREntity[] {
        for (const id of this.values()) {
            const entity = entities.get(id);
            if (entity && entity.label === label) found.push(entity);
        }

        if (this.parent) return this.parent.accessibleEntitiesWithLabel(label, entities, found);

        return found;
    }

    newSubScope(): IRScope {
        return new IRScope(this);
    }
}
