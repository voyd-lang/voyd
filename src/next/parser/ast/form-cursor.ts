import { Expr } from "./expr.js";
import { Form } from "./form.js";

/** Utility to iterate over a form's elements without mutating the form itself. */
export class FormCursor {
  // TODO: Determine if we should use fastshift array here
  #elements: readonly Expr[];
  #index: number;

  constructor(elements: readonly Expr[], index = 0) {
    this.#elements = elements;
    this.#index = index;
  }

  static fromForm(form: Form) {
    return new FormCursor(form.toArray());
  }

  get done() {
    return this.#index >= this.#elements.length;
  }

  get position() {
    return this.#index;
  }

  peek(offset = 0): Expr | undefined {
    return this.#elements[this.#index + offset];
  }

  consume(): Expr | undefined {
    if (this.done) return undefined;
    const expr = this.#elements[this.#index];
    this.#index += 1;
    return expr;
  }

  /** Skips `count` elements and returns the cursor. */
  skip(count: number) {
    this.#index = Math.min(
      this.#elements.length,
      this.#index + Math.max(count, 0)
    );
    return this;
  }

  /** Rewinds the cursor `count` elements. */
  rewind(count = 1) {
    this.#index = Math.max(0, this.#index - Math.max(count, 0));
    return this;
  }

  /**
   * Consumes elements while the predicate returns true.
   * The predicate receives the next element and its index.
   */
  consumeWhile(
    predicate: (expr: Expr | undefined, index: number) => boolean
  ): Expr[] {
    const results: Expr[] = [];
    while (!this.done && predicate(this.peek(), this.#index)) {
      const expr = this.consume();
      if (expr) results.push(expr);
    }
    return results;
  }

  /** Returns a lightweight clone positioned at the same index. */
  fork() {
    return new FormCursor(this.#elements, this.#index);
  }

  /** Remaining elements without advancing the cursor. */
  rest(): Expr[] {
    return this.#elements.slice(this.#index);
  }
}
