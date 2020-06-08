import { Scope } from "./scope";

/** Any item that can be referenced by an identifier */
export type Entity =
    FunctionEntity |
    TypeEntity |
    LocalEntity;

export type EntityWithoutID =
    Omit<FunctionEntity, "id"> |
    Omit<TypeEntity, "id"> |
    Omit<LocalEntity, "id">;

export interface FunctionEntity extends EntityBase {
    kind: "function";

    /** Entity ID */
    parameters: string[];

    /** Entity ID */
    returnType?: string;
}

/** Represents types such as structs, enums, and type aliases. i.e. `type Foo =` or `declare type` */
export interface TypeEntity extends EntityBase {
    kind: "type";

    /** Binaryen type ref */
    binType?: number;

    typeEntity?: string;
}


export interface LocalEntity extends EntityBase {
    kind: "local";
    mutable: boolean;
    index: number;
    typeEntity?: string;
}

/** A declared definition */
export interface EntityBase {
    kind: string;
    id: string;
    label: string;
    flags: string[];
    scope: Scope;
}

/** Tracks the locals of a WASM function */
export interface LocalsTracker {
    /** The number of parameters in a function. Represents where the index should start. */
    offset: number;

    values: number[];
}
