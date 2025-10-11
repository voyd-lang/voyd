#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { parseModuleFromSrc } from "../src/parser/index.js";
import { registerModules } from "../src/semantics/modules.js";
import { expandFunctionalMacros } from "../src/semantics/functional-macros.js";
import { initPrimitiveTypes } from "../src/semantics/init-primitive-types.js";
import { initEntities } from "../src/semantics/init-entities.js";
import { resolveEntities } from "../src/semantics/resolution/resolve-entities.js";
import { VoydModule } from "../src/syntax-objects/module.js";
import { canonicalizeResolvedTypes } from "../src/semantics/types/canonicalize-resolved-types.js";
import { CanonicalTypeTable } from "../src/semantics/types/canonical-type-table.js";
import { checkTypes } from "../src/semantics/check-types/index.js";

const args = process.argv.slice(2);
const runCheckTypes = args.includes("--check-types");

const targetEntries = args
  .filter((arg) => !arg.startsWith("--"))
  .map((p) => path.resolve(process.cwd(), p));

if (!targetEntries.length) {
  targetEntries.push(
    path.resolve(process.cwd(), "test.voyd"),
    path.resolve(process.cwd(), "std/map.voyd")
  );
}

const formatRelative = (value: string) =>
  path.relative(process.cwd(), value) || value;

const processEntry = async (entry: string) => {
  console.log(`\n→ Processing ${formatRelative(entry)}`);

  const parsedModule = await parseModuleFromSrc(entry);

  let moduleExpr = registerModules(parsedModule) as VoydModule;
  moduleExpr = expandFunctionalMacros(moduleExpr) as VoydModule;
  moduleExpr = initPrimitiveTypes(moduleExpr) as VoydModule;
  moduleExpr = initEntities(moduleExpr) as VoydModule;
  moduleExpr = resolveEntities(moduleExpr) as VoydModule;

  const table = new CanonicalTypeTable({ recordEvents: true });
  canonicalizeResolvedTypes(moduleExpr, { table });

  const dedupeEvents = table.getDedupeEvents();
  console.log(`  - canonicalized types: ${dedupeEvents.length}`);

  if (runCheckTypes) {
    checkTypes(moduleExpr);
    console.log("  - type checking completed");
  }
};

Promise.all(targetEntries.map((entry) => processEntry(entry))).catch(
  (error) => {
    console.error("\nCanonicalization phase script failed:", error);
    process.exitCode = 1;
  }
);
