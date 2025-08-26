#!/usr/bin/env tsx
import { compileSrc } from "../compiler.js";
import { argv } from "process";

const [, , filePath, filter] = argv;

if (!filePath) {
  console.error("Usage: tsx src/tools/print-type-hierarchy.ts <file> [filter]");
  process.exit(1);
}

const mod = await compileSrc(filePath);
const text = mod.emitText();
const lines = text.split("\n");

const typeRegex = /^\s*\(type \$([^\s]+)(?: \(sub \$([^\s]+))?/;
const parentMap = new Map<string, string | undefined>();

for (const line of lines) {
  const match = line.match(typeRegex);
  if (match) {
    const [, name, parent] = match;
    parentMap.set(name, parent);
  }
}

function chain(name: string): string {
  const result = [name];
  let current = name;
  while (parentMap.get(current)) {
    const next = parentMap.get(current)!;
    result.push(next);
    current = next;
  }
  return result.join(" -> ");
}

for (const name of parentMap.keys()) {
  if (!filter || name.includes(filter)) {
    console.log(chain(name));
  }
}
