import { SourceLocation, Syntax, VerboseJSON } from "./syntax.js";

export type AtomOpts = {
  location?: SourceLocation;
  value?: string;
};

export class Atom extends Syntax {
  value: string;

  constructor(opts: AtomOpts | string = "") {
    if (typeof opts === "string") {
      super();
      this.value = opts;
      return;
    }

    super(opts);
    this.value = opts.value ?? "";
  }

  clone(): Atom {
    return new Atom({
      location: this.location?.clone(),
      value: this.value,
    });
  }

  toJSON() {
    return this.value;
  }

  toVerboseJSON(): VerboseJSON {
    return {
      type: "atom",
      location: this.location?.toJSON(),
      attributes: this.attributes,
      value: this.value,
    };
  }
}
