import { Value } from "./definitions";

export class Values {
    private readonly identifiers: { [key: string]: Value };

    constructor(ids?: { [key: string]: Value }) {
        this.identifiers = ids ? JSON.parse(JSON.stringify(ids)) : {};
    }

    register(id: Value) {
        this.identifiers[id.identifier] = id;
    }

    retrieve(id: string): Value {
        const ident = this.identifiers[id];
        if (!ident) {
            throw new Error(`Unknown identifier: ${id}`);
        }

        return ident;
    }

    clone() {
        return new Values(this.identifiers);
    }
}
