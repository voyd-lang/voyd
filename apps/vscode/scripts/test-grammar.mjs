import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const grammarPath = path.resolve(__dirname, "../syntaxes/voyd.tmLanguage.json");
const grammar = JSON.parse(fs.readFileSync(grammarPath, "utf8"));
const functionDefinitionPattern = grammar.repository["function-definition"];
const functionCallPatterns = grammar.repository["function-call"]?.patterns ?? [];
const clausePattern = functionCallPatterns.find(
  (pattern) => pattern.name === "meta.function-call.operator-word.voyd"
);
const interpolationPattern = grammar.repository["string-interpolation"];
const stringPattern = grammar.repository.constants?.patterns?.find(
  (pattern) => pattern.name === "string.quoted.double.voyd"
);
const constantPattern = grammar.repository.constants?.patterns?.find(
  (pattern) => pattern.name === "constant.language.voyd"
);
const openEffectRowPattern = grammar.repository.keywords?.patterns?.find(
  (pattern) => pattern.name === "keyword.other.effect-row.voyd"
);
const controlKeywordPattern = grammar.repository.keywords?.patterns?.find(
  (pattern) => pattern.name === "keyword.control.voyd"
);
const declarationKeywordPatterns = grammar.repository.keywords?.patterns?.filter(
  (pattern) =>
    pattern.name === "keyword.other.voyd" || pattern.name === "storage.type.voyd",
);
const builtinTypePattern = grammar.repository.keywords?.patterns?.find(
  (pattern) => pattern.name === "entity.name.type.voyd",
);
const operatorPatterns = grammar.repository.keywords?.patterns?.filter((pattern) =>
  pattern.name?.startsWith("keyword.operator"),
);
const attributePattern = grammar.repository.attributes;
const namespacePattern = grammar.repository.identifiers?.patterns?.find(
  (pattern) => pattern.name === "variable.language.voyd",
);
const numericPattern = grammar.repository.constants?.patterns?.find(
  (pattern) => pattern.name === "constant.numeric.voyd",
);

const matchesEntirePattern = (pattern, value) =>
  new RegExp(`^(?:${pattern.match})$`).test(value);

const assertMatchesAny = (patterns, values, message) =>
  values.forEach((value) =>
    assert(
      patterns.some((pattern) => matchesEntirePattern(pattern, value)),
      `${message}: ${value}`,
    ),
  );

assert(functionDefinitionPattern, "Expected function definition grammar pattern");
assert.equal(
  functionDefinitionPattern.captures?.["2"]?.name,
  "entity.name.function.voyd",
  "Function declaration names should use the function entity scope",
);
["fn add(a: i32)", "fn id<T>(value: T)", "fn '+'(a: i32, b: i32)"].forEach(
  (declaration) =>
    assert(
      new RegExp(functionDefinitionPattern.match).test(declaration),
      `Expected function declaration to be highlighted: ${declaration}`,
    ),
);
assert(
  !new RegExp(functionDefinitionPattern.match).test("fn(i32) -> i32"),
  "Function types should not be mistaken for function declarations",
);

assert(clausePattern, "Expected clause-call grammar pattern to exist");
assert.equal(
  clausePattern.beginCaptures?.["1"]?.name,
  "entity.name.function.voyd",
  "Clause-style calls should be highlighted as function names"
);
assert(
  clausePattern.patterns?.some((pattern) => pattern.include === "#keywords"),
  "Clause-style calls should parse keywords between argument lists and the final colon",
);
const clauseIncludes = clausePattern.patterns?.map((pattern) => pattern.include) ?? [];
assert(
  clauseIncludes.indexOf("#type-arguments") < clauseIncludes.indexOf("#keywords"),
  "Clause-style calls should parse type arguments before keyword operators",
);

const clauseRegex = new RegExp(clausePattern.begin, "g");
const regexMatches = (line) => [...line.matchAll(clauseRegex)].map((match) => match[0]);

assert(
  regexMatches("  for (i, x) in arr.enumerate():").includes("enumerate"),
  "Expected clause-style method call names to match the clause-call grammar"
);
assert(
  !regexMatches("    if required <= __array_len(self.storage):").includes("required"),
  "Comparison expressions should not be mistaken for clause-style function calls"
);

assert(interpolationPattern, "Expected string interpolation grammar pattern to exist");
assert.equal(
  interpolationPattern.begin,
  "\\$\\{",
  "String interpolation should begin with ${"
);

assert(stringPattern, "Expected double-quoted string grammar pattern to exist");
assert(
  stringPattern.patterns?.some((pattern) => pattern.include === "#string-interpolation"),
  "Double-quoted strings should include interpolation parsing"
);

assert(constantPattern, "Expected named constant grammar pattern to exist");
const constantRegex = new RegExp(constantPattern.match, "g");
assert(
  constantRegex.test("NEG_INFINITY"),
  "Expected NEG_INFINITY to be highlighted as a named constant"
);
assert(
  !constantRegex.test("MyType"),
  "PascalCase type names should not be highlighted as named constants"
);

assert(openEffectRowPattern, "Expected explicit open effect-row grammar pattern to exist");
const openEffectRowRegex = new RegExp(openEffectRowPattern.match, "g");
assert(
  openEffectRowRegex.test("fn call(cb: fn() : (Async, open) -> i32) -> i32"),
  "Expected open callback effect-row markers to be highlighted"
);
assert(
  !openEffectRowRegex.test("let open = 1"),
  "Expected ordinary identifiers named open to avoid effect-row highlighting"
);

assert(controlKeywordPattern, "Expected control keyword grammar pattern to exist");
assertMatchesAny(
  [controlKeywordPattern],
  [
    "if",
    "then",
    "else",
    "elif",
    "while",
    "for",
    "match",
    "return",
    "break",
    "continue",
    "do",
    "tail",
    "resume",
    "try",
    "try open",
  ],
  "Expected current control syntax to be highlighted",
);

assert(declarationKeywordPatterns?.length, "Expected declaration keyword patterns");
assertMatchesAny(
  declarationKeywordPatterns,
  [
    "use",
    "pub",
    "mod",
    "impl",
    "api",
    "pri",
    "fn",
    "type",
    "obj",
    "val",
    "trait",
    "let",
    "var",
    "macro",
    "macro_let",
    "eff",
    "test",
    "enum",
  ],
  "Expected current declaration syntax to be highlighted",
);
["where", "union", "global"].forEach((word) =>
  assert(
    !declarationKeywordPatterns.some((pattern) => matchesEntirePattern(pattern, word)),
    `Expected stale keyword '${word}' to remain an ordinary identifier`,
  ),
);

assert(builtinTypePattern, "Expected built-in type grammar pattern to exist");
assertMatchesAny(
  [builtinTypePattern],
  ["i32", "i64", "f32", "f64", "bool", "void"],
  "Expected current built-in types to be highlighted",
);
["voyd", "string"].forEach((word) =>
  assert(
    !matchesEntirePattern(builtinTypePattern, word),
    `Expected stale built-in type '${word}' to remain an ordinary identifier`,
  ),
);

assert(operatorPatterns?.length, "Expected operator grammar patterns");
assertMatchesAny(
  operatorPatterns,
  [
    "+",
    "-",
    "*",
    "/",
    "%",
    "^",
    "==",
    "!=",
    "<",
    ">",
    "<=",
    ">=",
    ".",
    "?.",
    "|>",
    "<|",
    "|",
    "&",
    "=",
    "+=",
    "-=",
    "*=",
    "/=",
    "->",
    "=>",
    ":",
    "?:",
    ":=",
    "::",
    ";",
    "??",
    "..",
    "..=",
    "..<",
    "and",
    "or",
    "xor",
    "as",
    "is",
    "is_subtype_of",
    "in",
    "has_trait",
    "#",
    "!",
    "@",
    "~",
    "not",
    "...",
  ],
  "Expected parser operators to be highlighted without whitespace requirements",
);
["extends", "final"].forEach((word) =>
  assert(
    !operatorPatterns.some((pattern) => matchesEntirePattern(pattern, word)),
    `Expected stale operator '${word}' to remain an ordinary identifier`,
  ),
);

assert(attributePattern, "Expected compiler attribute grammar pattern to exist");
["boundary", "compiler_contract", "effect", "external", "intrinsic", "intrinsic_type", "serializer"].forEach(
  (attribute) =>
    assert(
      matchesEntirePattern(attributePattern, `@${attribute}`),
      `Expected @${attribute} to be highlighted as an attribute`,
    ),
);

assert(namespacePattern, "Expected module namespace grammar pattern to exist");
assertMatchesAny(
  [namespacePattern],
  ["self", "super", "src", "std", "pkg"],
  "Expected module root namespaces to be highlighted",
);

assert(numericPattern, "Expected numeric literal grammar pattern to exist");
assertMatchesAny(
  [numericPattern],
  ["42", "-1", "1.5", "2e10", "3.0E-2", "7i64", "1.25f32"],
  "Expected current numeric literal forms to be highlighted",
);

[grammar.patterns, grammar.repository.expression?.patterns].forEach((patterns) => {
  const includes = patterns?.map((pattern) => pattern.include) ?? [];
  assert(
    includes.indexOf("#function-definition") < includes.indexOf("#keywords"),
    "Function definitions must take precedence over the standalone fn keyword",
  );
  assert(
    includes.indexOf("#comment") < includes.indexOf("#keywords"),
    "Comments must take precedence over the division operator",
  );
});

const interpolationRegex = new RegExp(interpolationPattern.begin, "g");
assert(
  [..."\"\\rScanlines remaining: ${image_height - i}\"".matchAll(interpolationRegex)].length === 1,
  "Expected interpolation regex to match ${...} within strings that include escape prefixes"
);

console.log("Voyd grammar regression checks passed");
