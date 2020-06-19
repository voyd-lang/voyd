import { Value, LocalValue } from "../definitions";

export class ValueCollection {
    private readonly values: { [key: string]: Value };
    private readonly locals: LocalValue[];

    constructor({ vals, locals }: {
        vals?: { [key: string]: Value },
        locals?: LocalValue[]
    } = {}) {
        this.values = vals ? JSON.parse(JSON.stringify(vals)) : {};
        this.locals = locals ? JSON.parse(JSON.stringify(locals)) : [];
    }

    /**
     * Register a value. If the value is a local,
     * the index will be overwritten to the next available index.
     * @param val
     */
    register(val: Value) {
        if (val.kind === "local") {
            this.locals.push({
                ...val,
                index: this.locals.length
            });
            return;
        }

        this.values[val.id] = val;
    }

    retrieve(id: string): Value {
        const ident = this.values[id];
        if (ident) return ident;
        const local = this.locals.find(l => l.id === id);
        if (local) return local;

        throw new Error(`Unknown identifier: ${id}`);
    }

    getNonParameterLocalTypes(): number[] {
        return this.locals
            .filter(l => l.nonParameter)
            .map(l => l.type);
    }

    clone() {
        return new ValueCollection({ vals: this.values, locals: this.locals });
    }
}
