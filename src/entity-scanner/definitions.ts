import { DistributiveOmit } from "../helpers";
import { Scope } from "../scope";

export type NewEntity = DistributiveOmit<Entity, "id">;

export type OrderedEntity = Entity & { order: number };

/** Any item that can be referenced by an identifier */
export type Entity =
    FunctionEntity |
    TypeAliasEntity |
    VariableEntity |
    ParameterEntity |
    ImplEntity;

export interface FunctionEntity extends EntityBase {
    kind: "function";

    /** Entity ID */
    parameters: string[];

    returnTypeEntity?: TypeEntity;
}

/** Represents some form of type alias */
export interface TypeAliasEntity extends TypeEntity {
    kind: "type-alias";

    instanceScope: Scope;
}

/** A value can be t */
export interface VariableEntity extends EntityBase {
    kind: "variable";
    mutable: boolean;
    index: number;
    tokenIndex: number;
    typeEntity?: TypeEntity;
}

/** A value can be t */
export interface ParameterEntity extends EntityBase {
    kind: "parameter";
    mutable: boolean;
    index: number;
    typeEntity?: TypeEntity;
}

export interface ImplEntity extends EntityBase {
    kind: "impl";
    traitEntity?: Entity;
}

export interface TypeEntity extends EntityBase {
    instanceScope: Scope;
}

/** A declared definition */
export interface EntityBase {
    id: string
    kind: EntityKind;
    label: string;
    flags: string[];
}

export type EntityKind = "function" | "variable" | "parameter" | "impl" | "type-alias";
