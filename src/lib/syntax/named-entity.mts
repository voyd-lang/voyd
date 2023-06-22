import { Identifier } from "./identifier.mjs";
import { Syntax, SyntaxOpts } from "./syntax.mjs";

export type NamedEntityOpts = SyntaxOpts & { name: Identifier | string };

export abstract class NamedEntity extends Syntax {
  readonly name: Identifier;

  constructor(opts: NamedEntityOpts) {
    super(opts);
    this.name =
      typeof opts.name === "string" ? Identifier.from(opts.name) : opts.name;
  }
}
