import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import { toFileUri } from "../project/files.js";
import { AnalysisCoordinator } from "../server/analysis-coordinator.js";

const runPerf = process.env.VOYD_LS_PERF === "1";
const perfIt = runPerf ? it : it.skip;

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const middleValue = sorted[middle];
  if (middleValue === undefined) {
    return 0;
  }
  return sorted.length % 2 === 0 && sorted[middle - 1] !== undefined
    ? (middleValue + sorted[middle - 1]!) / 2
    : middleValue;
};

const leafSource = (index: number): string => `pub fn leaf_${index}() -> i32\n  ${index}\n`;

const createPerfProject = async ({
  leafCount,
}: {
  leafCount: number;
}): Promise<{ rootDir: string; entryUri: string; leafPathFor: (index: number) => string }> => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "voyd-ls-perf-"));
  const srcDir = path.join(rootDir, "src");
  await mkdir(srcDir, { recursive: true });

  const useLines = Array.from({ length: leafCount }, (_, index) =>
    `use src::leaf_${index}::leaf_${index}`,
  ).join("\n");
  const sumExpression = Array.from(
    { length: leafCount },
    (_, index) => `leaf_${index}()`,
  ).join(" + ");

  await writeFile(
    path.join(srcDir, "core.voyd"),
    `${useLines}\n\npub fn total() -> i32\n  ${sumExpression}\n`,
    "utf8",
  );
  await writeFile(
    path.join(srcDir, "main.voyd"),
    `use src::core::total\n\nfn main() -> i32\n  total()\n`,
    "utf8",
  );
  await Promise.all(
    Array.from({ length: leafCount }, (_entry, index) =>
      writeFile(path.join(srcDir, `leaf_${index}.voyd`), leafSource(index), "utf8"),
    ),
  );

  return {
    rootDir,
    entryUri: toFileUri(path.join(srcDir, "main.voyd")),
    leafPathFor: (index: number) => path.join(srcDir, `leaf_${index}.voyd`),
  };
};

describe("analysis coordinator perf harness", () => {
  perfIt(
    "keeps post-edit diagnostics analysis faster than full project analysis",
    async () => {
      const leafCount = Number.parseInt(process.env.VOYD_LS_PERF_LEAF_COUNT ?? "350", 10);
      const editRuns = Number.parseInt(process.env.VOYD_LS_PERF_EDIT_RUNS ?? "5", 10);
      const minSpeedup = Number.parseFloat(
        process.env.VOYD_LS_PERF_MIN_SPEEDUP ?? "1.0",
      );
      const project = await createPerfProject({ leafCount });
      const coordinator = new AnalysisCoordinator();

      try {
        const initialStart = performance.now();
        await coordinator.getCoreForUri(project.entryUri);
        const initialMs = performance.now() - initialStart;

        const editDurations: number[] = [];
        for (let run = 0; run < editRuns; run += 1) {
          const leafPath = project.leafPathFor(run % leafCount);
          const leafUri = toFileUri(leafPath);
          coordinator.updateDocument(
            TextDocument.create(
              leafUri,
              "voyd",
              run + 1,
              `pub fn leaf_${run % leafCount}() -> i32\n  ${10_000 + run}\n`,
            ),
          );

          const runStart = performance.now();
          await coordinator.getCoreForUri(project.entryUri);
          editDurations.push(performance.now() - runStart);
        }

        const medianPostEditMs = median(editDurations);
        const speedup = initialMs / Math.max(1, medianPostEditMs);

        console.info(
          `[ls-perf] leafCount=${leafCount} initialMs=${initialMs.toFixed(2)} medianPostEditMs=${medianPostEditMs.toFixed(2)} speedup=${speedup.toFixed(2)}x`,
        );

        expect(speedup).toBeGreaterThanOrEqual(minSpeedup);
      } finally {
        await rm(project.rootDir, { recursive: true, force: true });
      }
    },
    240_000,
  );
});
