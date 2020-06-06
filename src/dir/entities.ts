import { IREntity, IRInstruction, IREntityWithoutID } from "./definitions";
import uniqid from "uniqid";

export class IREntities {
    private readonly entities: Map<string, IREntity> = new Map();

    entries(): Iterator<[string, IREntity]> {
        return this.entities.entries();
    }

    /** Returns the ID of the entity. */
    addEntity(entity: IREntityWithoutID): string {
        const id = uniqid();
        const fullEntity = { id, ...entity } as IREntity;
        this.entities.set(id, fullEntity);
        return id;
    }

    get(id: string) {
        return this.entities.get(id);
    }

    updateFunction(id: string, items: {
        locals: string[];
        body: IRInstruction[];
    }) {
        const fn = this.get(id);

        if (!fn) {
            throw new Error("Function not found");
        }

        if (fn.kind !== "function") {
            throw new Error(`${fn.label} is not a function`);
        }

        fn.locals = items.locals;
        fn.body = items.body;
    }
}
