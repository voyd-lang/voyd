import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const dispositionLedgerPath = resolve(root, "docs/testing/test-inventory.json");
const ignoredDirectories = new Set([
  ".git",
  ".turbo",
  "dist",
  "build",
  "node_modules",
]);
const isTestFile = (file) =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) || file.endsWith(".test.voyd");

const files = walk(root)
  .map((file) => relative(root, file))
  .filter(isTestFile)
  .sort();
const inventory = files.map((file) => {
  const source = readFileSync(resolve(root, file), "utf8");
  return {
    file,
    owner: ownerFor(file),
    cases: countCases(source, file),
    lines: source.split("\n").length,
    compileHeavy: /\b(?:sdk\.)?compile\s*\(|compileProgram\s*\(/.test(source),
  };
});
const conformanceManifest = JSON.parse(
  readFileSync(resolve(root, "tests/conformance/manifest.json"), "utf8"),
);
const conformanceCaseCount = conformanceManifest.suites.reduce(
  (total, suite) => total + suite.cases.length,
  0,
);

if (process.argv.includes("--write-inventory")) {
  const dispositionLedger = updateDispositionLedger(inventory);
  writeFileSync(
    dispositionLedgerPath,
    `${JSON.stringify(dispositionLedger, null, 2)}\n`,
  );
}

if (process.argv.includes("--check")) {
  const violations = [
    ...checkInventory(inventory),
    ...checkDispositionLedger(inventory),
  ];
  if (violations.length > 0) {
    throw new Error(`Test architecture violations:\n${violations.join("\n")}`);
  }
}

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
} else {
  printSummary(inventory);
}

function walk(directory) {
  return readdirSync(directory).flatMap((entry) => {
    if (ignoredDirectories.has(entry)) {
      return [];
    }
    const path = resolve(directory, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function ownerFor(file) {
  if (file.startsWith("tests/conformance/")) return "language-conformance";
  if (file.startsWith("tests/integration/")) return "cross-package-integration";
  if (file.startsWith("tests/performance/")) return "performance";
  if (file.startsWith("packages/compiler/")) return "compiler-implementation";
  if (file.startsWith("packages/sdk/")) return "sdk-contract";
  if (file.startsWith("apps/cli/")) return "cli-contract";
  if (file.endsWith(".test.voyd")) return "voyd-library";
  if (file.startsWith("scripts/ci/")) return "ci-tooling";
  return "package-unit";
}

function countCases(source, file) {
  const pattern = file.endsWith(".voyd")
    ? /^\s*test\s+["']/gm
    : /^\s*(?:it|test)(?:\.each)?\s*\(/gm;
  return [...source.matchAll(pattern)].length;
}

function checkInventory(entries) {
  const violations = [];
  entries.forEach(({ file }) => {
    const source = readFileSync(resolve(root, file), "utf8");
    if (/\b(?:it|test|describe)\.only\s*\(/.test(source)) {
      violations.push(`${file}: focused test committed with .only`);
    }
    if (
      file.startsWith("tests/conformance/") &&
      /@voyd-lang\/compiler|packages\/compiler|\.\.\/.*compiler/.test(source)
    ) {
      violations.push(
        `${file}: conformance tests may not import compiler internals`,
      );
    }
  });
  if (entries.some(({ file }) => file.startsWith("apps/smoke/"))) {
    violations.push("apps/smoke: obsolete test location must remain empty");
  }
  const manifestIds = conformanceManifest.suites.flatMap((suite) => [
    suite.id,
    ...suite.cases.map((testCase) => testCase.id),
  ]);
  manifestIds
    .filter((id, index) => manifestIds.indexOf(id) !== index)
    .forEach((id) =>
      violations.push(`tests/conformance/manifest.json: duplicate id ${id}`),
    );
  conformanceManifest.suites.forEach((suite) => {
    const entry = resolve(root, "tests/conformance", suite.entry);
    if (!existsSync(entry)) {
      violations.push(
        `tests/conformance/manifest.json: missing entry ${suite.entry}`,
      );
    }
  });
  return violations;
}

function updateDispositionLedger(entries) {
  const existingEntries = existsSync(dispositionLedgerPath)
    ? JSON.parse(readFileSync(dispositionLedgerPath, "utf8"))
    : [];
  const existingByFile = new Map(
    existingEntries.map((entry) => [entry.file, entry]),
  );
  return entries.map(({ file, owner }) => {
    const existing = existingByFile.get(file);
    if (existing?.owner === owner) return existing;
    return {
      file,
      owner,
      disposition: "needs-review",
      rationale:
        "Classify this test by the contract it protects before committing it.",
    };
  });
}

function checkDispositionLedger(expectedEntries) {
  if (!existsSync(dispositionLedgerPath)) {
    return [
      "docs/testing/test-inventory.json: missing; run npm run test:audit:update",
    ];
  }

  const actualEntries = JSON.parse(readFileSync(dispositionLedgerPath, "utf8"));
  const violations = [];
  const conformanceCaseIds = new Set(
    conformanceManifest.suites.flatMap((suite) =>
      suite.cases.map((testCase) => testCase.id),
    ),
  );
  const actualByFile = new Map();
  actualEntries.forEach((entry) => {
    if (actualByFile.has(entry.file)) {
      violations.push(
        `docs/testing/test-inventory.json: duplicate entry ${entry.file}`,
      );
    }
    actualByFile.set(entry.file, entry);
  });

  const expectedByFile = new Map(
    expectedEntries.map((entry) => [entry.file, entry]),
  );
  expectedEntries.forEach((expected) => {
    const actual = actualByFile.get(expected.file);
    if (!actual) {
      violations.push(
        `docs/testing/test-inventory.json: missing entry ${expected.file}; run npm run test:audit:update`,
      );
      return;
    }
    if (actual.owner !== expected.owner) {
      violations.push(
        `docs/testing/test-inventory.json: stale owner for ${expected.file}; run npm run test:audit:update and review the pending decision`,
      );
    }
    if (actual.disposition === "needs-review") {
      violations.push(
        `docs/testing/test-inventory.json: ${expected.file} needs an explicit ownership review`,
      );
    }
    if (!isAllowedDisposition(actual.owner, actual.disposition)) {
      violations.push(
        `docs/testing/test-inventory.json: invalid disposition ${actual.disposition} for ${expected.file}`,
      );
    }
    if (typeof actual.rationale !== "string" || actual.rationale.length < 20) {
      violations.push(
        `docs/testing/test-inventory.json: ${expected.file} needs a substantive retention rationale`,
      );
    }
    if (
      actual.owner === "compiler-implementation" &&
      !/^\d{4}-\d{2}-\d{2}$/.test(actual.reviewed ?? "")
    ) {
      violations.push(
        `docs/testing/test-inventory.json: ${expected.file} needs a dated contract review`,
      );
    }
    if (
      [
        "compiler-local-with-portable-signal",
        "compiler-local-with-portable-signal-and-gap",
      ].includes(actual.disposition) &&
      (!Array.isArray(actual.portableCaseIds) ||
        actual.portableCaseIds.length === 0)
    ) {
      violations.push(
        `docs/testing/test-inventory.json: ${expected.file} must name its representative portable cases`,
      );
    }
    if (
      actual.disposition === "compiler-local-portable-gap" &&
      Array.isArray(actual.portableCaseIds) &&
      actual.portableCaseIds.length > 0
    ) {
      violations.push(
        `docs/testing/test-inventory.json: ${expected.file} cannot claim case ids while classified as an uncovered portable gap`,
      );
    }
    if (
      [
        "compiler-local-portable-gap",
        "compiler-local-with-portable-signal-and-gap",
      ].includes(actual.disposition) &&
      (typeof actual.portableGap !== "string" || actual.portableGap.length < 20)
    ) {
      violations.push(
        `docs/testing/test-inventory.json: ${expected.file} must describe its portable backlog`,
      );
    }
    if (Array.isArray(actual.portableCaseIds)) {
      actual.portableCaseIds.forEach((id) => {
        if (!conformanceCaseIds.has(id)) {
          violations.push(
            `docs/testing/test-inventory.json: ${expected.file} references unknown conformance case ${id}`,
          );
        }
      });
    }
  });
  actualEntries.forEach(({ file }) => {
    if (!expectedByFile.has(file)) {
      violations.push(
        `docs/testing/test-inventory.json: stale removed-file entry ${file}; run npm run test:audit:update`,
      );
    }
  });
  return violations;
}

function isAllowedDisposition(owner, disposition) {
  const allowedByOwner = {
    "language-conformance": ["portable-conformance"],
    "cross-package-integration": ["cross-package-integration"],
    performance: ["opt-in-performance"],
    "compiler-implementation": [
      "compiler-local",
      "compiler-local-with-portable-signal",
      "compiler-local-with-portable-signal-and-gap",
      "compiler-local-portable-gap",
    ],
    "sdk-contract": ["sdk-local"],
    "cli-contract": ["cli-local"],
    "voyd-library": ["library-local"],
    "ci-tooling": ["tooling-local"],
    "package-unit": ["package-local"],
  };
  return allowedByOwner[owner]?.includes(disposition) ?? false;
}

function printSummary(entries) {
  const byOwner = new Map();
  entries.forEach((entry) => {
    const aggregate = byOwner.get(entry.owner) ?? {
      files: 0,
      cases: 0,
      lines: 0,
      compileHeavy: 0,
    };
    aggregate.files += 1;
    aggregate.cases += entry.cases;
    aggregate.lines += entry.lines;
    aggregate.compileHeavy += Number(entry.compileHeavy);
    byOwner.set(entry.owner, aggregate);
  });
  const conformance = byOwner.get("language-conformance");
  if (conformance) {
    conformance.cases = conformanceCaseCount;
    conformance.compileHeavy = conformanceManifest.suites.length;
  }

  process.stdout.write(
    "| Owner | Files | Cases | Lines | Compile-heavy groups/files |\n",
  );
  process.stdout.write("| --- | ---: | ---: | ---: | ---: |\n");
  [...byOwner.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([owner, value]) => {
      process.stdout.write(
        `| ${owner} | ${value.files} | ${value.cases} | ${value.lines} | ${value.compileHeavy} |\n`,
      );
    });
}
