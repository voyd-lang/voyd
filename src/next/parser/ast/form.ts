import { FastShiftArray } from "@lib/fast-shift-array.js";
import { AST } from "./ast.js";
import { SourceLocation, Syntax, VerboseJSON } from "./syntax.js";

export type FormOpts = {
  location?: SourceLocation;
  elements?: AST[];
};

export class Form extends Syntax {
  #elements: FastShiftArray<AST>;

  constructor(opts: FormOpts | AST[] = []) {
    if (Array.isArray(opts)) {
      super();
      this.#elements = new FastShiftArray(...opts);
      return;
    }

    super(opts);
    this.#elements = new FastShiftArray(...(opts.elements ?? []));
  }

  at(index: number): AST | undefined {
    return this.#elements.at(index);
  }

  push(...elements: AST[]) {
    this.#elements.push(...elements);
  }

  clone(): Form {
    return new Form({
      location: this.location?.clone(),
      elements: this.#elements.toArray().map((e) => e.clone()),
    });
  }

  toArray(): AST[] {
    return this.#elements.toArray();
  }

  toJSON() {
    return this.toArray();
  }

  toVerboseJSON(): VerboseJSON {
    return {
      type: "form",
      location: this.location?.toJSON(),
      elements: this.#elements.toArray().map((e) => e.toVerboseJSON()),
    };
  }
}
