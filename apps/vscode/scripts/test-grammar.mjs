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

console.log("Voyd grammar regression checks passed");
