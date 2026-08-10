import { BoolAtom, IdentifierAtom } from "../../ast/atom.js";
import {
  arrayLiteral,
  call,
  Expr,
  identifier,
  isForm,
  label,
  objectLiteral,
  string,
  surfaceCall,
} from "../../ast/index.js";
import type { SourceLocation } from "../../ast/syntax.js";
import { CharStream } from "../../char-stream.js";
import { ParserSyntaxError } from "../../errors.js";

type ParseOptions = {
  onUnescapedCurlyBrace: (stream: CharStream) => Expr | undefined;
};

type HtmlAttribute = { name: string; value: Expr; location?: SourceLocation };

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
    const { key, attributes: propsOrAttrs } = splitKeyAttribute(
      this.parseAttributes(),
    );

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
        return this.applyKeyAttribute(
          surfaceCall("::", left, inner).setLocation(
            this.stream.currentSourceLocation(),
          ),
          key,
        );
      }

      return this.applyKeyAttribute(
        surfaceCall(tagName, propsObj).setLocation(
          this.stream.currentSourceLocation(),
        ),
        key,
      );
    }

    // Built-in element: element(tag: "div", attrs: [...], children: [...])
    const attributes = propsOrAttrs.map(({ name, value, location }) =>
      this.lowerHtmlAttribute(tagName, name, value, location),
    );
    const children = selfClosing
      ? emptyHtmlChildren()
      : this.parseChildren(tagName);
    const args = [label("tag", string(tagName))];

    if (attributes.length) {
      args.push(label("attrs", arrayLiteral(...attributes)));
    }

    args.push(label("children", children));

    return this.applyKeyAttribute(
      vxHelperCall("html_element", ...args).setLocation(
        this.stream.currentSourceLocation(),
      ),
      key,
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
    const items: HtmlAttribute[] = [];
    while (this.stream.next !== ">" && this.stream.next !== "/") {
      this.consumeWhitespace();
      const location = this.stream.currentSourceLocation();
      const name = this.parseAttributeName();
      if (!name) break;
      if (this.stream.next === "=") {
        this.stream.consumeChar(); // Consume '='
        const value = this.parseAttributeValue();
        location.setEndToStartOf(this.stream.currentSourceLocation());
        items.push({ name, value, location });
      } else {
        // Boolean attribute -> true
        location.setEndToStartOf(this.stream.currentSourceLocation());
        items.push({ name, value: new BoolAtom("true"), location });
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

  private lowerHtmlAttribute(
    tagName: string,
    name: string,
    value: Expr,
    location?: SourceLocation,
  ): Expr {
    const sourceLocation = location ?? this.stream.currentSourceLocation();
    if (name.startsWith("on_")) {
      const eventValue = unwrapInlineLambdaExpr(value);
      const eventName = domEventNameForHtmlAttribute(name);
      if (!isLambdaExpr(eventValue)) {
        return vxHelperCall(
          "html_event_message",
          label("name", string(eventName)),
          label("message", eventValue),
        ).setLocation(sourceLocation);
      }
      const eventHelper = eventLambdaAcceptsPayload(eventValue)
        ? "html_event_payload_handler"
        : "html_event_handler";
      return vxHelperCall(
        eventHelper,
        label("name", string(eventName)),
        label("handler", eventValue),
      ).setLocation(sourceLocation);
    }

    if (name === "class") {
      return vxHelperCall(name, value).setLocation(sourceLocation);
    }

    if (name === "value") {
      if (valueAttributeTags.has(tagName)) {
        return vxHelperCall(
          "attr",
          label("name", string(name)),
          label("value", value),
        ).setLocation(sourceLocation);
      }
      if (tagName !== "input" && tagName !== "textarea") {
        const alternative =
          tagName === "select"
            ? "; use the 'selected' attribute on the matching <option>"
            : "";
        this.throwSyntaxError(
          `JSX property 'value' has no stable SSR representation on <${tagName}>${alternative}`,
          sourceLocation,
      );
    }
      return vxHelperCall(name, value).setLocation(sourceLocation);
    }

    if (name === "checked") {
      if (tagName !== "input") {
        const alternative =
          tagName === "option" ? "; use the 'selected' attribute instead" : "";
        this.throwSyntaxError(
          `JSX property 'checked' has no stable SSR representation on <${tagName}>${alternative}`,
          sourceLocation,
        );
      }
      return vxHelperCall(name, value).setLocation(sourceLocation);
    }

    if (name === "disabled") {
      if (!disableableTags.has(tagName)) {
        this.throwSyntaxError(
          `JSX property 'disabled' has no stable SSR representation on <${tagName}>`,
          sourceLocation,
        );
      }
      return vxHelperCall(name, value).setLocation(sourceLocation);
    }

    return vxHelperCall(
      "attr",
      label("name", string(name)),
      label("value", value),
    ).setLocation(sourceLocation);
  }

  private applyKeyAttribute(node: Expr, key: Expr | undefined): Expr {
    if (!key) return node;
    return vxHelperCall(
      "keyed",
      label("key", key),
      label("child", node),
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

    const result =
      children.length > 0
        ? arrayLiteral(...children.map((child) => vxHelperCall("html_child", child)))
        : emptyHtmlChildren();

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

  private withChildrenProp(props: HtmlAttribute[], tagName: string) {
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

  private throwSyntaxError(
    message: string,
    location = this.stream.currentSourceLocation(),
  ): never {
    throw new ParserSyntaxError(message, location);
  }
}

const splitKeyAttribute = (
  attributes: HtmlAttribute[],
): { key?: Expr; attributes: HtmlAttribute[] } => {
  const key = attributes.find((attribute) => attribute.name === "key")?.value;
  if (!key) return { attributes };
  return {
    key,
    attributes: attributes.filter((attribute) => attribute.name !== "key"),
  };
};

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

const isObjectLiteralExpr = (
  expr: Expr,
): expr is Extract<
  Expr,
  { at(index: number): Expr | undefined; length: number }
> =>
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
        : typeof item === "string" && item.trim().length > 0,
    );
};

const domEventNameForHtmlAttribute = (name: string): string => {
  const eventName = name.slice("on_".length);
  if (eventName === "double_click") return "dblclick";
  return eventName.replaceAll("_", "");
};

const valueAttributeTags = new Set([
  "button",
  "data",
  "li",
  "meter",
  "option",
  "param",
  "progress",
]);

const disableableTags = new Set([
  "button",
  "fieldset",
  "input",
  "optgroup",
  "option",
  "select",
  "textarea",
]);

const ARRAY_TYPE_MODULE_ID = "std::array";
const VX_HELPER_MODULE_ID = "std::vx";

const compilerOwnedIdentifier = ({
  moduleId,
  name,
}: {
  moduleId: string;
  name: string;
}): IdentifierAtom => {
  const identifier = new IdentifierAtom(name);
  identifier.lexicalContext = {
    kind: "symbol-reference",
    targetModuleId: moduleId,
    bindingKey: `compiler-symbol:${moduleId}:${name}`,
    compilerOwned: true,
  };
  return identifier;
};

const vxHelperIdentifier = (name: string): IdentifierAtom =>
  compilerOwnedIdentifier({ moduleId: VX_HELPER_MODULE_ID, name });

const vxHelperCall = (name: string, ...args: Expr[]): Expr =>
  call(vxHelperIdentifier(name), ...args);

const emptyHtmlChildren = (): Expr =>
  call(
    identifier("::"),
    call(
      compilerOwnedIdentifier({
        moduleId: ARRAY_TYPE_MODULE_ID,
        name: "Array",
      }),
      call(
        "generics",
        compilerOwnedIdentifier({
          moduleId: VX_HELPER_MODULE_ID,
          name: "HtmlNode",
        }),
      ),
    ),
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
