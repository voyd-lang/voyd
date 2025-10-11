#!/usr/bin/env node

import { parseModule } from "../src/parser/index.js";
import { registerModules } from "../src/semantics/modules.js";
import { expandFunctionalMacros } from "../src/semantics/functional-macros.js";
import { initPrimitiveTypes } from "../src/semantics/init-primitive-types.js";
import { initEntities } from "../src/semantics/init-entities.js";
import { resolveEntities } from "../src/semantics/resolution/resolve-entities.js";
import { Identifier } from "../src/syntax-objects/index.js";
import { VoydModule } from "../src/syntax-objects/module.js";
import { Type, TypeAlias, UnionType } from "../src/syntax-objects/types.js";
import { typeKey } from "../src/semantics/types/type-key.js";
import {
  configureTypeKeyTrace,
  getActiveTypeKeyTraceConfig,
} from "../src/semantics/types/type-key-trace.js";

type CollisionEntry = {
  fingerprint: string;
  kind: "alias" | "union";
  name: string;
  modulePath: string;
  id: string;
};

const args = process.argv.slice(2);
const traceIndex = args.findIndex((arg) => arg === "--trace");
if (traceIndex !== -1) {
  const value = args[traceIndex + 1];
  const names =
    value && !value.startsWith("--")
      ? value.split(",").map((part) => part.trim()).filter(Boolean)
      : undefined;
  configureTypeKeyTrace({ names });
}

const main = async () => {
if (!getActiveTypeKeyTraceConfig()) {
  configureTypeKeyTrace({});
  }

  const parsed = await parseModule("use std::all");
  let expr = registerModules(parsed) as unknown as VoydModule;
  expr = expandFunctionalMacros(expr) as VoydModule;
  expr = initPrimitiveTypes(expr) as VoydModule;
  expr = initEntities(expr) as VoydModule;
  expr = resolveEntities(expr) as VoydModule;

  const stdModule = expr.resolveModule(Identifier.from("std"));
  if (!stdModule) {
    console.error("Unable to locate std module after resolution.");
    process.exitCode = 1;
    return;
  }

  const collisions = collectDuplicates(stdModule);

  if (!collisions.length) {
    console.log("No duplicate typeKey fingerprints detected in std library.");
    return;
  }

  console.log(
    `Found ${collisions.length} duplicate fingerprint group${
      collisions.length === 1 ? "" : "s"
    }:\n`
  );

  collisions.forEach(({ fingerprint, entries }) => {
    console.log(`fingerprint: ${fingerprint}`);
    entries.forEach((entry) => {
      console.log(
        `  - [${entry.kind}] ${entry.modulePath}::${entry.name} (id=${entry.id})`
      );
    });
    console.log("");
  });
};

type CollisionGroup = {
  fingerprint: string;
  entries: CollisionEntry[];
};

const collectDuplicates = (root: VoydModule): CollisionGroup[] => {
  const byFingerprint = new Map<string, CollisionEntry[]>();
  const queue: VoydModule[] = [root];
  const seenModules = new Set<VoydModule>();
  const seenAliases = new Set<string>();
  const seenUnions = new Set<string>();

  while (queue.length) {
    const module = queue.shift()!;
    if (seenModules.has(module)) continue;
    seenModules.add(module);

    module.getAllEntities().forEach((entity) => {
      if (entity.isModule?.()) {
        queue.push(entity as VoydModule);
        return;
      }

      if ((entity as TypeAlias).isTypeAlias?.()) {
        const alias = entity as TypeAlias;
        if (seenAliases.has(alias.id)) return;
        seenAliases.add(alias.id);
        registerEntry(byFingerprint, alias.type ?? alias, {
          kind: "alias",
          name: alias.name.toString(),
          modulePath: modulePath(module),
          id: alias.id,
        });
        return;
      }

      if ((entity as UnionType).isUnionType?.()) {
        const union = entity as UnionType;
        if (seenUnions.has(union.id)) return;
        seenUnions.add(union.id);
        registerEntry(byFingerprint, union, {
          kind: "union",
          name: union.name?.toString?.() ?? union.syntaxId.toString(),
          modulePath: modulePath(module),
          id: union.id,
        });
      }
    });
  }

  return Array.from(byFingerprint.entries())
    .filter(([, entries]) => entries.length > 1)
    .map(([fingerprint, entries]) => ({
      fingerprint,
      entries,
    }));
};

const registerEntry = (
  map: Map<string, CollisionEntry[]>,
  type: Type,
  entry: Omit<CollisionEntry, "fingerprint">
) => {
  const fingerprint = typeKey(type);
  const existing = map.get(fingerprint) ?? [];
  existing.push({ fingerprint, ...entry });
  map.set(fingerprint, existing);
};

const modulePath = (module: VoydModule): string =>
  module.getPath().slice(1).join("::") || module.name.toString();

main().catch((error) => {
  console.error("Failed to analyze std library fingerprints:", error);
  process.exitCode = 1;
});
