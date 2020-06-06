import { IREntities, IREntity, IREntityWithoutID, IRInstruction } from "./definitions";
import uniqid from "uniqid";

export class IR {
    /** Stores all identifiers in the entire WASM module */
    private readonly entities: IREntities = {};

    /** All of the entities the module exports */
    private readonly exports: string[] = [];

    /** Key is the namespace id */
    private readonly namespaces: Record<string, {
        /** Parent namespace id, if any */
        parent?: string;

        entities: string[]
    }> = {};

    readonly stdNamespaceID: string;

    constructor() {
        this.stdNamespaceID = uniqid();
        this.namespaces[this.stdNamespaceID] = { entities: [] };
    }

    exportEntity(id: string) {
        this.exports.push(id);
    }

    addEntityToSTD(id: string) {
        this.namespaces[this.stdNamespaceID].entities.push(id);
    }

    /** Get entity with id. */
    getEntity(id: string): IREntity {
        return this.entities[id];
    }

    namespaceHasEntity(entityID: string, namespaceID: string): boolean {
        const namespace = this.namespaces[namespaceID];

        if (namespace.entities.includes(entityID)) return true;

        if (namespace.parent) {
            return this.namespaceHasEntity(entityID, namespace.parent);
        }

        return false;
    }

    findEntitiesWithLabel(
        label: string,
        namespaceID: string = this.stdNamespaceID,
        entities: IREntity[] = []
    ): IREntity[] {
        const namespace = this.namespaces[namespaceID];

        for (const id of namespace.entities) {
            const entity = this.entities[id];
            if (entity.label === label) entities.push(entity);
        }

        if (namespace.parent) {
            return this.findEntitiesWithLabel(label, namespace.parent, entities);
        }

        return entities;
    }

    /**
     * Returns the ID of the entity.
     * If namespace is supplied, the entity will be added to that namespace
     */
    addEntity(entity: IREntityWithoutID, namespaceID: string): string {
        const id = uniqid();
        const fullEntity = { id, ...entity } as IREntity;
        this.entities[id] = fullEntity;

        const namespace = this.namespaces[namespaceID];
        if (!namespace) {
            throw new Error(`No namespace with id ${namespaceID}`);
        }
        namespace.entities.push(id);

        return id;
    }

    updateFunction(id: string, items: {
        locals: string[];
        body: IRInstruction[];
    }) {
        const fn = this.getEntity(id);

        if (fn.kind !== "function") {
            throw new Error(`${fn.label} is not a function`);
        }

        fn.locals = items.locals;
        fn.body = items.body;
    }

    /** Returns a new namespace id */
    newNamespace(parent: string = this.stdNamespaceID): string {
        const id = uniqid();

        this.namespaces[id] = {
            parent,
            entities: []
        };

        return id;
    }

    // For debug use. DELETE ME SOMETIME.
    logEntitiesOfNamespace(id: string) {
        const namespace = this.namespaces[id];

        for (const id of namespace.entities) {
            console.log(this.getEntity(id).label);
        }

        if (namespace.parent) this.logEntitiesOfNamespace(namespace.parent);
    }
}
