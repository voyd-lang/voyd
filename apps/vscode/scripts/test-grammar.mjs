import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const grammarPath = path.resolve(__dirname, "../syntaxes/voyd.tmLanguage.json");
const grammar = JSON.parse(fs.readFileSync(grammarPath, "utf8"));
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

assert(clausePattern, "Expected clause-call grammar pattern to exist");
assert.equal(
  clausePattern.beginCaptures?.["1"]?.name,
  "entity.name.function.voyd",
  "Clause-style calls should be highlighted as function names"
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

const interpolationRegex = new RegExp(interpolationPattern.begin, "g");
assert(
  [..."\"\\rScanlines remaining: ${image_height - i}\"".matchAll(interpolationRegex)].length === 1,
  "Expected interpolation regex to match ${...} within strings that include escape prefixes"
);

console.log("Voyd grammar regression checks passed");
