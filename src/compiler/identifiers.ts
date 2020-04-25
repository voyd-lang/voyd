import { Identifier } from "./definitions";

export class IdentifiersCollection {
    private readonly identifiers: { [key: string]: Identifier } = {};

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
}
