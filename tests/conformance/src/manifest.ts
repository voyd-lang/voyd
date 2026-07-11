import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ConformanceHostInteraction,
  ConformanceHostScenario,
} from "./compiler-adapter.js";

export type ConformanceExpectation =
  | { kind: "compile-success" }
  | {
      kind: "diagnostics";
      codes: string[];
      messageIncludes?: string[];
      spans?: Array<{ code: string; text: string }>;
    }
  | { kind: "equals"; value: unknown }
  | { kind: "number-range"; minInclusive: number; maxExclusive: number }
  | { kind: "trap"; messageIncludes?: string[] }
  | {
      kind: "wasm";
      exports?: string[];
      imports?: string[];
      absentImports?: string[];
    };

export type ConformanceCase = {
  id: string;
  title: string;
  entryName?: string;
  host?: ConformanceHostScenario;
  interactions?: ConformanceHostInteraction[];
  expect: ConformanceExpectation;
};

export type ConformanceSuite = {
  id: string;
  title: string;
  entry: string;
  optimize?: boolean;
  tags: string[];
  cases: ConformanceCase[];
};

type ConformanceManifest = {
  version: 1;
  suites: ConformanceSuite[];
};

const conformanceRoot = resolve(import.meta.dirname, "..");

export const loadConformanceManifest = (): ConformanceManifest => {
  const manifestPath = resolve(conformanceRoot, "manifest.json");
  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  ) as ConformanceManifest;
  validateManifest(manifest);
  return manifest;
};

export const resolveConformanceEntry = (entry: string): string =>
  resolve(conformanceRoot, entry);

const validateManifest = (manifest: ConformanceManifest): void => {
  if (manifest.version !== 1 || !Array.isArray(manifest.suites)) {
    throw new Error("Unsupported conformance manifest");
  }

  const ids = manifest.suites.flatMap((suite) => [
    suite.id,
    ...suite.cases.map((testCase) => testCase.id),
  ]);
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicateIds.length > 0) {
    throw new Error(
      `Duplicate conformance ids: ${[...new Set(duplicateIds)].join(", ")}`,
    );
  }

  manifest.suites.forEach((suite) => {
    if (suite.entry.startsWith("/") || suite.entry.includes("..")) {
      throw new Error(
        `Conformance entry must stay within the corpus: ${suite.entry}`,
      );
    }
    if (suite.cases.length === 0) {
      throw new Error(`Conformance suite has no cases: ${suite.id}`);
    }
  });
};
