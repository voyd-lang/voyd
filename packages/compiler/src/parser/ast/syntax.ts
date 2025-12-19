export abstract class Syntax {
  abstract readonly syntaxType: string;
  readonly syntaxId = getSyntaxId();
  location?: SourceLocation;
  attributes?: Attributes;

  constructor(opts: { location?: SourceLocation; attributes?: Attributes } = {}) {
    this.location = opts.location;
    this.attributes = cloneAttributes(opts.attributes);
  }

  abstract clone(): Syntax;
  abstract toJSON(): unknown;
  abstract toVerboseJSON(): VerboseJSON;

  setLocation(loc?: SourceLocation) {
    this.location = loc;
    return this;
  }

  setEndLocationToStartOf(loc: SourceLocation) {
    this.location?.setEndToStartOf(loc);
    return this;
  }
}

export type Attributes = { [key: string]: unknown };

export const cloneAttributes = (
  attributes?: Attributes
): Attributes | undefined => {
  if (!attributes) {
    return undefined;
  }
  return { ...attributes };
};

export type VerboseJSON = {
  type: string;
  id: number;
  location?: SourceLocationJSON;
  attributes?: Attributes;
  [key: string]: unknown;
};

export type SourceLocationJSON = {
  startIndex: number;
  endIndex: number;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  filePath: string;
};

export class SourceLocation {
  /** The exact character index the syntax starts */
  startIndex: number;
  /** The exact character index the syntax ends */
  endIndex: number;
  /** The line the syntax is located in */
  startLine: number;
  endLine: number;
  /** The column within the line the syntax begins */
  startColumn: number;
  /** The column index in the line where the syntax ends  */
  endColumn: number;

  filePath: string;

  constructor(opts: SourceLocationJSON) {
    this.startIndex = opts.startIndex;
    this.endIndex = opts.endIndex;
    this.startLine = opts.startLine;
    this.endLine = opts.endLine;
    this.startColumn = opts.startColumn;
    this.endColumn = opts.endColumn;
    this.filePath = opts.filePath;
  }

  setEndToStartOf(location?: SourceLocation) {
    if (!location) return;
    this.endIndex = location.startIndex;
    this.endColumn = location.startColumn;
    this.endLine = location.startLine;
  }

  setEndToEndOf(location?: SourceLocation) {
    if (!location) return;
    this.endIndex = location.endIndex;
    this.endColumn = location.endColumn;
    this.endLine = location.endLine;
  }

  toString() {
    return `${this.filePath}:${this.startLine}${
      this.endLine && this.endLine !== this.startLine ? `-${this.endLine}` : ""
    }:${this.startColumn + 1}${this.endColumn ? `-${this.endColumn + 1}` : ""}`;
  }

  toJSON() {
    return {
      startIndex: this.startIndex,
      endIndex: this.endIndex,
      startLine: this.startLine,
      endLine: this.endLine,
      startColumn: this.startColumn,
      endColumn: this.endColumn,
      filePath: this.filePath,
    };
  }

  clone() {
    return new SourceLocation(this.toJSON());
  }
}

let currentSyntaxId = 0;
export const getSyntaxId = () => {
  const current = currentSyntaxId;
  currentSyntaxId += 1;
  return current;
};
