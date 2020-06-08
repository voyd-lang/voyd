import uniqid from "uniqid";
import { Entity, EntityWithoutID } from "./definitions";
import { EventEmitter2 } from "eventemitter2";

export class Entities {
    private readonly emitter = new EventEmitter2();
    private readonly entities: Map<string, Entity> = new Map();

    entries(): Iterator<[string, Entity]> {
        return this.entities.entries();
    }

    /** Returns the ID of the entity. */
    add(entity: EntityWithoutID): string {
        const id = uniqid();
        const fullEntity = { id, ...entity } as Entity;
        this.entities.set(id, fullEntity);
        this.emitter.emit("Update", fullEntity);
        return id;
    }

    get(id: string): Entity {
        const entity = this.entities.get(id);

        if (!entity) {
            throw new Error(`Entity not found: ${id}`);
        }

        return entity;
    }

    update(entity: Partial<Entity>) {
        if (!entity.id) throw new Error("Entity must have ID");
        const updated: Entity = { ...this.entities.get(entity.id), ...entity } as Entity;
        this.entities.set(entity.id, updated);
        this.emitter.emit("Update", entity);
    }

    /** Emitted when an entity is added or updated */
    on(event: "Update", cb: (e: Entity) => void): void;
    on(event: string, cb: (...args: any[]) => void) {
        this.emitter.on(event, cb);
    }

    off(event: string, cb: (...args: any[]) => void) {
        this.emitter.off(event, cb);
    }
}
