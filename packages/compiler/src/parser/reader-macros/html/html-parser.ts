import {
  arrayLiteral,
  Expr,
  isForm,
  surfaceCall,
} from "../../ast/index.js";
import { BoolAtom } from "../../ast/atom.js";
import {
  call,
  identifier,
  label,
  objectLiteral,
  string,
} from "../../ast/index.js";
import { CharStream } from "../../char-stream.js";
import { ParserSyntaxError } from "../../errors.js";

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
    if (!node) this.throwSyntaxError("Expected HTML node");
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
    const propsOrAttrs = this.parseAttributes();

    const selfClosing = this.stream.next === "/";
    if (selfClosing) this.stream.consumeChar();
    this.consumeExpectedChar({
      expected: ">",
      message: "Malformed tag",
    });

    // Component: translate to function call with props object and children
    if (isComponent) {
      const props = !selfClosing
        ? this.withChildrenProp(propsOrAttrs, tagName)
        : propsOrAttrs;

      const propsObj = objectLiteral(
        ...props.map(({ name, value }) => label(name, value)),
      ).setLocation(this.stream.currentSourceLocation());

      // Namespaced component: e.g., UI::Card or UI::Elements::Card
      if (tagName.includes("::")) {
        const parts = tagName.split("::").filter(Boolean);
        const last = parts.pop()!;
        const left = buildModulePathLeft(parts);
        const inner = call(identifier(last), propsObj).setLocation(
          this.stream.currentSourceLocation(),
        );
        return surfaceCall("::", left, inner).setLocation(
          this.stream.currentSourceLocation(),
        );
      }

      return surfaceCall(tagName, propsObj).setLocation(
        this.stream.currentSourceLocation(),
      );
    }

    // Built-in element: element(tag: "div", attrs: [...], children: [...])
    const attributes = propsOrAttrs.map(({ name, value }) =>
      this.lowerVxAttribute(name, value),
    );
    const children = selfClosing ? emptyVxChildren() : this.parseChildren(tagName);
    const args = [label("tag", string(tagName))];

    if (attributes.length) {
      args.push(label("attrs", arrayLiteral(...attributes)));
    }

    args.push(label("children", children));

    return surfaceCall("element", ...args).setLocation(
      this.stream.currentSourceLocation(),
    );
  }

  private parseTagName(): string {
    let tagName = "";
    while (this.stream.hasCharacters) {
      const char = this.stream.next;
      if (!char || !/[a-zA-Z0-9:]/.test(char)) {
        break;
      }
      tagName += this.stream.consumeChar();
    }
    return tagName;
  }

  private parseAttributes() {
    const items: { name: string; value: Expr }[] = [];
    while (this.stream.next !== ">" && this.stream.next !== "/") {
      this.consumeWhitespace();
      const name = this.parseAttributeName();
      if (!name) break;
      if (this.stream.next === "=") {
        this.stream.consumeChar(); // Consume '='
        const value = this.parseAttributeValue();
        items.push({ name, value });
      } else {
        // Boolean attribute -> true
        items.push({ name, value: new BoolAtom("true") });
      }
      this.consumeWhitespace();
    }
    return items;
  }

  private parseAttributeName(): string {
    let name = "";
    while (this.stream.hasCharacters) {
      const char = this.stream.next;
      if (!char || !/[a-zA-Z0-9_-]/.test(char)) {
        break;
      }
      name += this.stream.consumeChar();
    }
    return name;
  }

  private parseAttributeValue(): Expr {
    const quote = this.stream.next;
    if (quote === "{") {
      const expr = this.options.onUnescapedCurlyBrace(this.stream);

      if (!expr) {
        this.throwSyntaxError(
          "Unescaped curly brace must be followed by an expression",
        );
      }

      return unwrapInlineExpr(expr);
    }

    if (quote !== '"' && quote !== "'") {
      this.throwSyntaxError("Attribute value must be quoted");
    }

    const valueStart = this.stream.currentSourceLocation();
    this.stream.consumeChar(); // Consume the opening quote

    let text = "";
    while (this.stream.hasCharacters && this.stream.next !== quote) {
      text += this.stream.consumeChar();
    }
    if (this.stream.next !== quote) {
      this.throwSyntaxError("Unterminated attribute value", valueStart);
    }
    this.stream.consumeChar(); // Consume the closing quote
    return string(text);
  }

  private lowerVxAttribute(name: string, value: Expr): Expr {
    if (name.startsWith("on_")) {
      const eventValue = unwrapInlineLambdaExpr(value);
      const eventName = domEventNameForVxAttribute(name);
      if (!isLambdaExpr(eventValue)) {
        return surfaceCall(
          "event_message",
          label("name", string(eventName)),
          label("message", eventValue),
        ).setLocation(this.stream.currentSourceLocation());
      }
      const eventHelper = eventLambdaAcceptsPayload(eventValue)
        ? "event_payload_handler"
        : "event_handler";
      return surfaceCall(
        eventHelper,
        label("name", string(eventName)),
        label("handler", eventValue),
      ).setLocation(this.stream.currentSourceLocation());
    }

    if (
      name === "class" ||
      name === "value" ||
      name === "disabled" ||
      name === "checked"
    ) {
      return surfaceCall(name, value).setLocation(
        this.stream.currentSourceLocation(),
      );
    }

    return surfaceCall(
      "attr",
      label("name", string(name)),
      label("value", value),
    ).setLocation(this.stream.currentSourceLocation());
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
        if (isForm(node) && node.callsInternal("array_literal")) {
          node.rest.forEach((expr) => children.push(expr));
          continue;
        }

        children.push(node);
      }

      if (!preserve) this.consumeWhitespace();
    }

    if (this.stream.hasCharacters && this.stream.next === `<`) {
      this.stream.consumeChar(); // Consume '<'
      this.consumeExpectedChar({
        expected: "/",
        message: `Expected closing tag </${tagName}>`,
      });
      const closingTagStart = this.stream.currentSourceLocation();
      const closingTagName = this.parseTagName();
      if (closingTagName !== tagName) {
        this.throwSyntaxError(
          `Mismatched closing tag, expected </${tagName}> but got </${closingTagName}>`,
          closingTagStart,
        );
      }
      this.consumeExpectedChar({
        expected: ">",
        message: "Malformed closing tag",
      });
    }

    const result = children.length > 0 ? arrayLiteral(...children) : emptyVxChildren();

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

    return call("array_literal", ...node).setLocation(location);
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

  private withChildrenProp(
    props: { name: string; value: Expr }[],
    tagName: string,
  ) {
    const children = this.parseChildren(tagName);
    return [...props, { name: "children", value: children }];
  }

  private consumeExpectedChar({
    expected,
    message,
  }: {
    expected: string;
    message: string;
  }): void {
    const location = this.stream.currentSourceLocation();
    if (this.stream.next !== expected) {
      this.throwSyntaxError(message, location);
    }
    this.stream.consumeChar();
  }

  private throwSyntaxError(message: string, location = this.stream.currentSourceLocation()): never {
    throw new ParserSyntaxError(message, location);
  }
}

const unwrapInlineExpr = (expr: Expr): Expr => {
  const lambda = unwrapInlineLambdaExpr(expr);
  if (lambda !== expr) return lambda;
  if (isForm(expr) && expr.length === 1) {
    const only = expr.at(0);
    if (only && !isForm(only)) return only;
  }
  return expr;
};

const unwrapInlineLambdaExpr = (expr: Expr): Expr => {
  if (!isObjectLiteralExpr(expr) || expr.length !== 2) return expr;
  const only = expr.at(1);
  return only && isLambdaExpr(only) ? only : expr;
};

const isLambdaExpr = (expr: Expr): boolean => {
  const serialized = expr.toJSON();
  return Array.isArray(serialized) && serialized.includes("=>");
};

const isObjectLiteralExpr = (expr: Expr): expr is Extract<Expr, { at(index: number): Expr | undefined; length: number }> =>
  isForm(expr) &&
  Array.isArray(expr.toJSON()) &&
  (expr.toJSON() as unknown[])[0] === "object_literal";

const eventLambdaAcceptsPayload = (expr: Expr): boolean => {
  const serialized = expr.toJSON();
  if (!Array.isArray(serialized)) return false;
  const arrowIndex = serialized.indexOf("=>");
  if (arrowIndex <= 0) return false;
  const signatureArrowIndex = serialized
    .slice(0, arrowIndex)
    .findIndex((item) => item === "->");
  if (signatureArrowIndex < 0) return false;
  return serialized
    .slice(0, signatureArrowIndex)
    .some((item) =>
      Array.isArray(item)
        ? item.length > 1
        : typeof item === "string" && item.trim().length > 0
    );
};

const domEventNameForVxAttribute = (name: string): string => {
  const eventName = name.slice("on_".length);
  if (eventName === "double_click") return "dblclick";
  return eventName.replaceAll("_", "");
};

const emptyVxChildren = (): Expr =>
  surfaceCall(
    "::",
    surfaceCall("Array", call("generics", identifier("MsgPack"))),
    surfaceCall("init"),
  );

// Build nested left side for a module path (e.g., ["::", ["::", A, B], C])
const buildModulePathLeft = (segments: string[]) => {
  if (segments.length === 0) return identifier("");
  let left: Expr = identifier(segments[0]!);
  for (let i = 1; i < segments.length; i++) {
    left = surfaceCall("::", left, identifier(segments[i]!));
  }
  return left;
};
