import { SourceLocation } from "../syntax-objects/syntax.js";

const WHITESPACE = /^\s+$/;

export class Token {
  readonly location: SourceLocation;
  value = "";

  constructor(opts: { location: SourceLocation; value?: string }) {
    const { value, location } = opts;
    this.value = value ?? "";
    this.location = location;
  }

  get length() {
    return this.value.length;
  }

  get hasChars() {
    return !!this.value.length;
  }

  get isNumber() {
    return /^[0-9]+$/.test(this.value);
  }

  get first(): string | undefined {
    return this.value[0];
  }

  get isWhitespace() {
    return WHITESPACE.test(this.value);
  }

  addChar(string: string) {
    this.value += string;
  }

  is(string?: string) {
    return this.value === string;
  }

  setEndLocationToStartOf(location?: SourceLocation) {
    this.location.setEndToStartOf(location);
  }
}
