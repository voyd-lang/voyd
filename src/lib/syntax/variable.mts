import { Type } from "./types.mjs";

export class Variable extends Syntax {
  readonly name: string;
  readonly type: Type;
}
