import { Token } from "../token.js";
import { Internal } from "./internals.js";
import {
  cloneAttributes,
  SourceLocation,
  Syntax,
  VerboseJSON,
} from "./syntax.js";

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

  protected cloneInto(_cloned: this): void {}

  eq(val: Atom | string): boolean {
    return val instanceof Atom ? this.value === val.value : this.value === val;
  }

  clone(): this {
    const cloned = new this.ctor({
      location: this.location?.clone(),
      value: this.value,
    });
    cloned.attributes = this.attributes ? { ...this.attributes } : undefined;
    this.cloneInto(cloned);
    return cloned;
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
      ...(this.attributes
        ? { attributes: cloneAttributes(this.attributes) }
        : {}),
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

  protected override cloneInto(cloned: this): void {
    cloned.isQuoted = this.isQuoted;
  }
}

/** Represents an identifier created by a macro or the compiler */
export class InternalIdentifierAtom extends Atom {
  readonly syntaxType = "identifier";

  constructor(value: (AtomOpts & { value?: Internal }) | Internal) {
    super(value);
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

  protected override cloneInto(cloned: this): void {
    cloned.intType = this.intType;
  }
}

export class FloatAtom extends Atom {
  readonly syntaxType = "float";
  floatType: "f32" | "f64" = "f64";

  setType(t: "f32" | "f64") {
    this.floatType = t;
    return this;
  }

  protected override cloneInto(cloned: this): void {
    cloned.floatType = this.floatType;
  }
}

export class WhitespaceAtom extends Atom {
  readonly syntaxType = "whitespace";

  get isNewline() {
    return this.value === "\n";
  }

  get isSpace() {
    return !this.isNewline && !this.isIndent;
  }

  get isIndent() {
    return this.value === "  ";
  }
}
