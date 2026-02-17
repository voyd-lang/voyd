import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const parsingPath = resolve(root, "packages/compiler/src/semantics/binding/parsing.ts");
const typingPath = resolve(root, "packages/compiler/src/semantics/typing/type-system.ts");
const fixturePath = resolve(
  root,
  "packages/compiler/src/semantics/__tests__/__fixtures__/generic_constraints_std_preflight.voyd",
);

const parsingSource = readFileSync(parsingPath, "utf8");
const typingSource = readFileSync(typingPath, "utf8");

const parserMentionsConstraint = /\bconstraint\b/.test(parsingSource);
const typingMentionsConstraint = /\bconstraint\b/.test(typingSource);
const fixtureRun = spawnSync("node", ["scripts/voyd", "--run", fixturePath], {
  cwd: root,
  encoding: "utf8",
});
const fixtureCompiledAndRan =
  fixtureRun.status === 0 && fixtureRun.stdout.trim() === "1";

if (parserMentionsConstraint && typingMentionsConstraint && fixtureCompiledAndRan) {
  console.log("Generic constraints preflight passed.");
  process.exit(0);
}

const missing = [
  parserMentionsConstraint ? null : "parser/binder generic constraint support",
  typingMentionsConstraint ? null : "typing generic constraint support",
  fixtureCompiledAndRan
    ? null
    : "constraint fixture compilation/execution (packages/compiler/src/semantics/__tests__/__fixtures__/generic_constraints_std_preflight.voyd)",
].filter(Boolean);

console.error(
  [
    "Generic constraints preflight failed.",
    `Missing: ${missing.join(", ")}.`,
    "Land the upstream generic-constraints compiler PR before running the std API migration cutover.",
    fixtureRun.status === 0
      ? ""
      : `CLI error: ${(fixtureRun.stderr || fixtureRun.stdout).trim()}`,
  ].join(" "),
);
process.exit(1);
