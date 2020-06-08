import { Scope } from "./scope";
import { Entities } from "./entities";
import { Entity } from "./definitions";
import uniqid from "uniqid";

export class EntityResolver {
    private readonly entities: Entities;
    private readonly unresolved: Unresolved = new Map();

    constructor(entities: Entities) {
        this.entities = entities;
    }

    listUnresolved(): string[] {
        const labels: string[] = [];
        for (const [label, unresolvedForLabel] of this.unresolved.entries()) {
            if (unresolvedForLabel.size > 0) labels.push(label);
        }
        return labels;
    }

    resolveTypeEntity(req: Omit<EntityReq, "id">): void {
        const fullReq = { ...req, id: uniqid() };
        const { scope, label, resolver } = fullReq;

        // First, check if the entity already exists.
        const existing = scope.accessibleEntitiesWithLabel(label, this.entities);

        for (const entity of existing) {
            if (entity.kind !== "type") continue;
            return resolver(entity);
        }

        // An existing entity did not exist. Watch for it.
        this.addUnresolved(fullReq);
        const watcher = (entity: Entity) => {
            if (entity.kind !== "type") return;
            if (!entity.scope.hasEntity(entity.id)) return;
            resolver(entity);
            this.entities.off("Update", watcher);
            this.removeUnresolved(fullReq);
        };
        this.entities.on("Update", watcher);
    }

    resolveIdentifier(req: Omit<EntityReq, "id">): void {
        const fullReq = { ...req, id: uniqid() };
        const { scope, label, resolver } = fullReq;

        // First, check if the entity already exists.
        const existing = scope.accessibleEntitiesWithLabel(label, this.entities);

        for (const entity of existing) {
            if (entity.kind !== "local") continue;
            return resolver(entity);
        }

        // An existing entity did not exist. Watch for it.
        this.addUnresolved(fullReq);
        const watcher = (entity: Entity) => {
            if (entity.kind !== "local") return;
            if (!entity.scope.hasEntity(entity.id)) return;
            resolver(entity);
            this.entities.off("Update", watcher);
            this.removeUnresolved(fullReq);
        };
        this.entities.on("Update", watcher);
    }

    private addUnresolved(req: EntityReq) {
        if (!this.unresolved.has(req.label)) this.unresolved.set(req.label, new Map());
        const unresolvedForLabel = this.unresolved.get(req.label)!;
        unresolvedForLabel.set(req.id, req);
    }

    private removeUnresolved(req: EntityReq) {
        const unresolvedForLabel = this.unresolved.get(req.label);
        if (unresolvedForLabel) unresolvedForLabel.delete(req.id);
    }
}

/** Key is the unresolved label */
type Unresolved = Map<string, UnresolvedForLabel>;

/** Key is ID of the request. */
type UnresolvedForLabel = Map<string, EntityReq>;

type EntityReq = {
    id: string,
    label: string,
    scope: Scope,
    resolver: (e: Entity) => void
}
