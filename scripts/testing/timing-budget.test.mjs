import { describe, expect, it } from "vitest";
import { fileBudgetMs, wallBudgetMs } from "./timing-budget.mjs";

const budget = {
  maxWallMs: 420_000,
  maxWallMsByCommand: {
    "npm run test:unit:core:affected:ci": 630_000,
  },
  maxFileMs: 180_000,
  maxFileMsByBasename: {
    "slow.test.ts": 210_000,
  },
  maxFileMsByPathSuffix: {
    "apps/cli/src/__tests__/slow.test.ts": 240_000,
  },
};

describe("lane wall timing budgets", () => {
  it("uses an exact command override", () => {
    expect(
      wallBudgetMs(["npm", "run", "test:unit:core:affected:ci"], budget),
    ).toBe(630_000);
  });

  it("does not apply an override to a command with extra arguments", () => {
    expect(
      wallBudgetMs(
        ["npm", "run", "test:unit:core:affected:ci", "--", "--filter=x"],
        budget,
      ),
    ).toBe(420_000);
  });

  it("falls back to the lane default for other commands", () => {
    expect(
      wallBudgetMs(["npm", "run", "test:unit:tooling:affected:ci"], budget),
    ).toBe(420_000);
  });
});

describe("file timing budgets", () => {
  it("uses an exact path-suffix override before a basename override", () => {
    expect(
      fileBudgetMs(
        { file: "/checkout/apps/cli/src/__tests__/slow.test.ts" },
        budget,
      ),
    ).toBe(240_000);
  });

  it("normalizes Windows paths before matching a path suffix", () => {
    expect(
      fileBudgetMs(
        { file: "C:\\checkout\\apps\\cli\\src\\__tests__\\slow.test.ts" },
        budget,
      ),
    ).toBe(240_000);
  });

  it("matches a repository-relative report path", () => {
    expect(
      fileBudgetMs({ file: "apps/cli/src/__tests__/slow.test.ts" }, budget),
    ).toBe(240_000);
  });

  it("does not match a suffix without a path-segment boundary", () => {
    expect(
      fileBudgetMs(
        { file: "/checkout/not-apps/cli/src/__tests__/slow.test.ts" },
        budget,
      ),
    ).toBe(210_000);
  });

  it("falls back from a basename override to the lane default", () => {
    expect(fileBudgetMs({ file: "/checkout/other/slow.test.ts" }, budget)).toBe(
      210_000,
    );
    expect(
      fileBudgetMs({ file: "/checkout/other/ordinary.test.ts" }, budget),
    ).toBe(180_000);
  });
});
