import {
  ArrayLiteralForm,
  CallForm,
  LabelForm,
  ObjectLiteralForm,
} from "../../ast/form.js";
import { Expr, Form, is } from "../../ast/index.js";
import {
  arrayLiteral,
  call,
  identifier,
  label,
  objectLiteral,
  string,
  tuple,
} from "../../ast/initializers.js";
import { CharStream } from "../../char-stream.js";

type ParseOptions = {
  onUnescapedCurlyBrace: (stream: CharStream) => Expr | undefined;
};

export class HTMLParser {
  private stream: CharStream;
  private options: ParseOptions;
  // Controls how text-node whitespace is handled. Defaults to HTML's normal mode
  // (collapse sequences to a single space). Certain tags like <pre> | <textarea>
  // switch this to 'pre' within their children, preserving all whitespace.
  private whitespaceMode: "normal" | "pre" = "normal";

  constructor(stream: CharStream, options: ParseOptions) {
    this.stream = stream;
    this.options = options;
  }

  parse(startElement?: string): Expr {
    const node = this.parseNode(startElement);
    if (!node) throw new Error("Expected HTML node");
    return node;
  }

  private parseNode(startElement?: string): Expr | null {
    if (startElement) {
      return this.parseElement(startElement);
    }

    if (this.whitespaceMode === "normal") this.consumeWhitespace();
    if (this.stream.next === "<") {
      return this.parseElement();
    } else {
      return this.parseText();
    }
  }

  private parseElement(startElement?: string): Expr | null {
    if (!startElement && this.stream.consumeChar() !== "<") return null;

    const tagName = startElement ?? this.parseTagName();
    const lastSegment = tagName.split("::").pop() ?? "";
    const isComponent = /^[A-Z]/.test(lastSegment);
    // Parse attributes/props before closing the tag
    const propsOrAttrs = isComponent
      ? this.parseComponentPropsObject()
      : this.parseAttributes();

    const selfClosing = this.stream.next === "/";
    if (selfClosing) this.stream.consumeChar();
    if (this.stream.consumeChar() !== ">") throw new Error("Malformed tag");

    // Component: translate to function call with props object and children
    if (isComponent) {
      const props =
        !selfClosing && is(propsOrAttrs, ObjectLiteralForm)
          ? this.withChildrenProp(propsOrAttrs, tagName)
          : propsOrAttrs;

      // Namespaced component: e.g., UI::Card or UI::Elements::Card
      if (tagName.includes("::")) {
        const parts = tagName.split("::").filter(Boolean);
        const last = parts.pop()!;
        const left = buildModulePathLeft(parts);
        const inner = call(last, props).setLocation(
          this.stream.currentSourceLocation()
        );
        return call("::", left, inner).setLocation(
          this.stream.currentSourceLocation()
        );
      }

      return call(tagName, props).setLocation(
        this.stream.currentSourceLocation()
      );
    }

    // Built-in element: create_element("div", [(k, v), ...], [...])
    const nameExpr = string(tagName);
    const attributes = propsOrAttrs;
    const children = selfClosing ? arrayLiteral() : this.parseChildren(tagName);
    return call("create_element", nameExpr, attributes, children).setLocation(
      this.stream.currentSourceLocation()
    );
  }

  private parseTagName(): string {
    let tagName = "";
    while (/[a-zA-Z0-9:]/.test(this.stream.next)) {
      tagName += this.stream.consumeChar();
    }
    return tagName;
  }

  private parseAttributes() {
    // Attributes: Array<(String, String)> represented as array-literal of tuple-literals
    const items: Expr[] = [];
    while (this.stream.next !== ">" && this.stream.next !== "/") {
      this.consumeWhitespace();
      const name = this.parseAttributeName();
      if (!name) break;
      if (this.stream.next === "=") {
        this.stream.consumeChar(); // Consume '='
        const value = this.parseAttributeValue();
        items.push(tuple(string(name), value));
      } else {
        // Boolean attribute -> "true" string
        items.push(tuple(string(name), string("true")));
      }
      this.consumeWhitespace();
    }

    return arrayLiteral(items);
  }

  // Parse attributes into an object-literal for component calls
  private parseComponentPropsObject() {
    const fields: LabelForm[] = [];
    while (this.stream.next !== ">" && this.stream.next !== "/") {
      this.consumeWhitespace();
      const name = this.parseAttributeName();
      if (!name) break;

      let value: Expr;
      if (this.stream.next === "=") {
        this.stream.consumeChar();
        value = this.parseAttributeValue();
      } else {
        // Boolean attribute -> "true" string (consistent with HTML attributes)
        value = string("true");
      }

      fields.push(label(name, value));
      this.consumeWhitespace();
    }
    return objectLiteral(...fields).setLocation(
      this.stream.currentSourceLocation()
    );
  }

  private parseAttributeName(): string {
    let name = "";
    while (/[a-zA-Z0-9-]/.test(this.stream.next)) {
      name += this.stream.consumeChar();
    }
    return name;
  }

  private parseAttributeValue(): Expr {
    const quote = this.stream.next;
    if (quote === "{") {
      const expr = this.options.onUnescapedCurlyBrace(this.stream);

      if (!expr) {
        throw new Error(
          "Unescaped curly brace must be followed by an expression"
        );
      }

      return unwrapInlineExpr(expr);
    }

    if (quote !== '"' && quote !== "'") {
      throw new Error("Attribute value must be quoted");
    }

    this.stream.consumeChar(); // Consume the opening quote

    let text = "";
    while (this.stream.next !== quote) {
      text += this.stream.consumeChar();
    }
    this.stream.consumeChar(); // Consume the closing quote
    return string(text);
  }

  private parseChildren(tagName: string) {
    const lower = tagName.toLowerCase();
    const preserve = lower === "pre" || lower === "textarea";

    const prevMode = this.whitespaceMode;
    this.whitespaceMode = preserve ? "pre" : "normal";

    if (!preserve) this.consumeWhitespace();
    const children: Expr[] = [];
    while (
      this.stream.hasCharacters &&
      !(this.stream.at(0) === `<` && this.stream.at(1) === `/`)
    ) {
      if (this.stream.next === "{") {
        const expr = this.options.onUnescapedCurlyBrace(this.stream);
        if (expr) children.push(unwrapInlineExpr(expr));
        if (!preserve) this.consumeWhitespace();
        continue;
      }

      const node = this.parseNode();
      if (node) {
        // Flatten text-array nodes
        if (is(node, ArrayLiteralForm)) {
          node.toArray().forEach((e) => children.push(e));
        } else {
          children.push(node);
        }
      }

      if (!preserve) this.consumeWhitespace();
    }

    if (this.stream.hasCharacters && this.stream.next === `<`) {
      this.stream.consumeChar(); // Consume '<'
      if (this.stream.consumeChar() !== "/") {
        throw new Error(`Expected closing tag </${tagName}>`);
      }
      const closingTagName = this.parseTagName();
      if (closingTagName !== tagName) {
        throw new Error(
          `Mismatched closing tag, expected </${tagName}> but got </${closingTagName}>`
        );
      }
      if (this.stream.consumeChar() !== ">") {
        throw new Error("Malformed closing tag");
      }
    }

    const result = arrayLiteral(children);

    // Restore mode on exiting children
    this.whitespaceMode = prevMode;
    return result;
  }

  private parseText(): Expr {
    const node: Expr[] = [];
    const location = this.stream.currentSourceLocation();

    let text = "";
    while (this.stream.hasCharacters && this.stream.next !== "<") {
      if (this.stream.next === "{") {
        const normalized = this.normalizeText(text);
        if (normalized) node.push(string(normalized));
        text = "";
        const expr = this.options.onUnescapedCurlyBrace(this.stream);
        if (expr) node.push(unwrapInlineExpr(expr));
        continue;
      }

      text += this.stream.consumeChar();
    }

    const normalized = this.normalizeText(text);
    if (normalized) node.push(string(normalized));
    location.setEndToStartOf(this.stream.currentSourceLocation());

    return arrayLiteral(...node).setLocation(location);
  }

  private consumeWhitespace(): void {
    while (/\s/.test(this.stream.next)) {
      this.stream.consumeChar();
    }
  }

  // HTML whitespace handling
  // - normal: collapse all consecutive whitespace (including newlines, tabs)
  //           into a single space, preserving leading/trailing spaces when
  //           they exist in the original sequence.
  // - pre:    preserve text exactly as written
  private normalizeText(text: string): string {
    if (!text) return "";
    if (this.whitespaceMode === "pre") return text;
    // Collapse any run of whitespace to a single space
    const collapsed = text.replace(/\s+/g, " ");
    // Keep as-is (including leading/trailing space) but drop if empty
    return collapsed.length > 0 ? collapsed : "";
  }

  private withChildrenProp(props: ObjectLiteralForm, tagName: string) {
    const children = this.parseChildren(tagName);
    const fields = props.toArray() as LabelForm[];
    const nextProps = objectLiteral(...fields, label("children", children));
    const location = props.location?.clone();
    return location ? nextProps.setLocation(location) : nextProps;
  }
}

const unwrapInlineExpr = (expr: Expr): Expr => {
  if (is(expr, Form)) {
    if (expr.length === 1 && !is(expr, CallForm)) {
      const only = expr.at(0);
      if (only && !is(only, Form)) return only;
    }
  }
  return expr;
};

// Build nested left side for a module path (e.g., ["::", ["::", A, B], C])
const buildModulePathLeft = (segments: string[]) => {
  if (segments.length === 0) return identifier("");
  let left: Expr = identifier(segments[0]!);
  for (let i = 1; i < segments.length; i++) {
    left = call("::", left, identifier(segments[i]!));
  }
  return left;
};
