import { NamedEntity } from "../named-entity.js";
import { TypeJSON, Type } from "../types.js";

export abstract class BaseType extends NamedEntity {
  readonly syntaxType = "type";
  abstract readonly kindOfType: string;

  getType(): Type {
    return this as unknown as Type;
  }

  abstract toJSON(): TypeJSON;
}
