import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const parsingPath = resolve(root, "packages/compiler/src/semantics/binding/parsing.ts");
const typingPath = resolve(root, "packages/compiler/src/semantics/typing/type-system.ts");

const parsingSource = readFileSync(parsingPath, "utf8");
const typingSource = readFileSync(typingPath, "utf8");

const parserMentionsConstraint = /\bconstraint\b/.test(parsingSource);
const typingMentionsConstraint = /\bconstraint\b/.test(typingSource);

if (parserMentionsConstraint && typingMentionsConstraint) {
  console.log("Generic constraints preflight passed.");
  process.exit(0);
}

const missing = [
  parserMentionsConstraint ? null : "parser/binder generic constraint support",
  typingMentionsConstraint ? null : "typing generic constraint support",
].filter(Boolean);

console.error(
  [
    "Generic constraints preflight failed.",
    `Missing: ${missing.join(", ")}.`,
    "Land the upstream generic-constraints compiler PR before running the std API migration cutover.",
  ].join(" "),
);
process.exit(1);
