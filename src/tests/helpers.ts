
export function recursiveStripFields(obj: any, fields: string[]) {
    if (obj instanceof Object) {
        for (const field in obj) {
            if (fields.includes(field)) {
                delete obj[field];
                continue;
            }

            const val = obj[field];
            if (val instanceof Array && val[0] instanceof Object) {
                recursiveStripFields(val, fields);
                continue;
            }

            if (val instanceof Object) {
                recursiveStripFields(val, fields);
                continue;
            }
        }
    }

    if (obj instanceof Array) {
        for (const subObj of obj) {
            recursiveStripFields(subObj, fields);
        }
    }
}
