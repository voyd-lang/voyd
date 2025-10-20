import { Token } from "../token.js";
import { SourceLocation, Syntax, VerboseJSON } from "./syntax.js";

export type AtomOpts = {
  location?: SourceLocation;
  value?: string;
};

export class Atom extends Syntax {
  readonly syntaxType: string = "atom";
  value: string;

  constructor(opts: AtomOpts | Token | string = "") {
    if (typeof opts === "string") {
      super();
      this.value = opts;
      return;
    }

    if (opts instanceof Token) {
      super({ location: opts.location });
      this.value = opts.value;
      return;
    }

    super(opts);
    this.value = opts.value ?? "";
  }

  private get ctor(): new (opts: AtomOpts) => this {
    return this.constructor as new (opts: AtomOpts) => this;
  }

  clone(): this {
    return new this.ctor({
      location: this.location?.clone(),
      value: this.value,
    });
  }

  toJSON() {
    return this.value;
  }

  toVerboseJSON(): VerboseJSON {
    return {
      type: this.syntaxType,
      id: this.syntaxId,
      location: this.location?.toJSON(),
      value: this.value,
    };
  }
}

export class IdentifierAtom extends Atom {
  readonly syntaxType = "identifier";
  isQuoted = false;

  setIsQuoted(v: boolean) {
    this.isQuoted = v;
    return this;
  }
}

export class BoolAtom extends Atom {
  readonly syntaxType = "bool";
}

export class StringAtom extends Atom {
  readonly syntaxType = "string";
}

export class CommentAtom extends Atom {
  readonly syntaxType = "comment";
}

export class IntAtom extends Atom {
  readonly syntaxType = "int";
  intType: "i32" | "i64" = "i64";

  setType(t: "i32" | "i64") {
    this.intType = t;
    return this;
  }
}

export class FloatAtom extends Atom {
  readonly syntaxType = "float";
  floatType: "f32" | "f64" = "f64";

  setType(t: "f32" | "f64") {
    this.floatType = t;
    return this;
  }
}

export class WhitespaceAtom extends Atom {
  readonly syntaxType = "whitespace";
}
