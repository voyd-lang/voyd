import { NamedEntity } from "../named-entity.js";
import { TypeJSON } from "../types.js";

export abstract class BaseType extends NamedEntity {
  readonly syntaxType = "type";
  abstract readonly kindOfType: string;

  abstract toJSON(): TypeJSON;
}
