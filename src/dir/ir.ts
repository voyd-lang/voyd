import { IREntities, IREntity, IRFunctionEntity } from "./definitions";
import uniqid from "uniqid";

export class IR {
    /** Stores all identifiers in the entire WASM module */
    private readonly entities: IREntities = {};

    /** Std entities (stdlib) */
    private readonly std: string[] = [];

    /** All of the entities the module exports */
    private readonly exports: string[] = [];

    /** Key is the namespace id, value is a set of entity IDs accessible to the namespace */
    private readonly namespaces: { [id: string]: string[] } = {};

    exportEntity(id: string) {

    }

    addEntityToSTD(id: string) {
        const entity = this.entities[id];
        if (!entity) throw new Error(`Entity ${id} not found`);
        this.std.push(id);
    }

    getEntity(id: string, namespaceID: string): IREntity {
        const inNamespace = this.namespaces[namespaceID].some(nid => nid === id) ?
            true :
            this.std.some(nid => nid === id);

        if (!inNamespace) {
            throw new Error(`No entity with id ${id} found in supplied namespace`);
        }

        return this.entities[id];
    }

    findEntityByLabel(label: string, namespaceID: string): IREntity {
        const idFromNamespace = this.namespaces[namespaceID].find(nid => this.entities[nid].label === label);
        if (idFromNamespace) return this.entities[idFromNamespace];
        const idFromStd = this.std.find(nid => this.entities[nid].label === label);
        if (idFromStd) return this.entities[idFromStd];
        throw new Error(`${label} not found`);
    }

    findFunctionsWithLabel(label: string, namespaceID: string): IRFunctionEntity[] {
        return [...this.std, ...this.namespaces[namespaceID]]
            .map(id => this.entities[id])
            .filter(entity => entity.label === label && entity.kind === "function") as IRFunctionEntity[];
    }


    /**
     * Returns the ID of the entity.
     * If namespace is supplied, the entity will be added to that namespace
     */
    addEntity(entity: Omit<IREntity, "id">, namespaceID?: string): string {
        const id = uniqid();
        const fullEntity = { id, ...entity } as IREntity;
        this.entities[id] = fullEntity;

        if (namespaceID) {
            const namespace = this.namespaces[id];
            if (!namespace) throw new Error(`No namespace with id ${namespaceID}`);
            namespace.push(id);
        }

        return id;
    }

    /** Returns a new namespace id */
    newNamespace(parent?: string): string {
        const inherits = (() => {
            if (parent) {
                const entities = this.namespaces[parent];
                if (!entities) throw new Error(`Parent namespace ${parent} does not exist`);
                return Array.from(entities);
            }

            return [];
        })();

        const id = uniqid();
        this.namespaces[id] = Array.from(inherits);
        return id;
    }
}
