import { Identifier } from "./definitions";

export class IdentifiersCollection {
    private readonly identifiers: { [key: string]: Identifier };

    constructor(ids?: { [key: string]: Identifier }) {
        this.identifiers = ids ? JSON.parse(JSON.stringify(ids)) : {};
    }

    register(id: Identifier) {
        this.identifiers[id.identifier] = id;
    }

    retrieve(id: string): Identifier {
        const ident = this.identifiers[id];
        if (!ident) {
            throw new Error(`Unknown identifier: ${id}`);
        }

        return ident;
    }

    clone() {
        return new IdentifiersCollection(this.identifiers);
    }

    dir() {
        console.dir(this.identifiers);
    }
}
