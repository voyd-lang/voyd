import { parseModule } from "../src/parser/index.js";
import { processSemantics } from "../src/semantics/index.js";
import { mapRecursiveUnionVoyd } from "../src/__tests__/fixtures/map-recursive-union.js";
import { collectOptionalConstructors } from "../src/semantics/types/debug/collect-optional-constructors.js";
import { Type, TypeAlias, UnionType, ObjectType } from "../src/syntax-objects/types.js";
import { compile } from "../src/compiler.js";

const describeType = (
  type: Type | undefined,
  seen: Set<Type> = new Set()
): string => {
  if (!type) return "undefined";
  if (seen.has(type)) return `<cycle:${(type as any).id ?? "unknown"}>`;
  seen.add(type);
  if ((type as TypeAlias).isTypeAlias?.()) {
    const alias = type as TypeAlias;
    const target = alias.type;
    const result = `alias(${alias.id} -> ${describeType(target, seen)})`;
    seen.delete(type);
    return result;
  }
  if ((type as UnionType).isUnionType?.()) {
    const union = type as UnionType;
    const result = `union(${union.types
      .map((child) => describeType(child, seen))
      .join(", ")})`;
    seen.delete(type);
    return result;
  }
  if ((type as ObjectType).isObjectType?.()) {
    const obj = type as ObjectType;
    const args = obj.appliedTypeArgs
      ?.map((arg) => describeType(arg, seen))
      .join(", ");
    seen.delete(type);
    return `object(${obj.id}${args ? `<${args}>` : ""})`;
  }
  const result = `${(type as any).kindOfType ?? "unknown"}#${
    (type as any).id ?? "?"
  }`;
  seen.delete(type);
  return result;
};

const main = async () => {
  const parsed = await parseModule(mapRecursiveUnionVoyd);
  const canonical = processSemantics(parsed);

  const { some, none, unions, edges, parentByInstance } =
    collectOptionalConstructors(canonical);

  const summarize = (label: string, set: Set<ObjectType>) => {
    console.log(`\n${label}: ${set.size}`);
    [...set]
      .sort((a, b) => a.id.localeCompare(b.id))
      .forEach((obj) => {
        const arg = obj.appliedTypeArgs?.[0];
        const parent = obj.genericParent?.id ?? "none";
        console.log(
          `  ${obj.id} parent=${parent} arg=${describeType(
            arg as Type | undefined
          )}`
        );
      });
  };

  summarize("Some constructors in canonical AST", some);
  summarize("None constructors in canonical AST", none);
  console.log(`\nUnion count involving Optional constructors: ${unions.size}`);

  const someBase = [...some].find(
    (obj) => obj.genericParent?.id === "Some#144032"
  )?.genericParent;
  if (someBase) {
    const instances = someBase.genericInstances ?? [];
    console.log(
      `\nBase Some#144032 generic instances (${instances.length}): ${instances
        .map((inst) => inst.id)
        .sort()
        .join(", ")}`
    );
  }

  const edgeEntries = [...edges.entries()]
    .filter(([parent]) => parent.id.startsWith("Some#"))
    .map(([parent, children]) => ({
      parent: parent.id,
      children: [...children].map((child) => child.id).sort(),
    }));
  if (edgeEntries.length) {
    console.log("\nOptional constructor edges:");
    edgeEntries.forEach(({ parent, children }) => {
      console.log(`  ${parent} -> [${children.join(", ")}]`);
    });
  }

  const lookupParent = (id: string) => {
    const entry = [...parentByInstance.entries()].find(
      ([instance]) => instance.id === id
    );
    return entry ? entry[1].id : undefined;
  };

  const wasmModule = await compile(mapRecursiveUnionVoyd);
  const wasmText = wasmModule.emitText();
  wasmModule.dispose?.();

  const structRe = /\(type \$([^\s()]+)\s+\(sub/g;
  const structNames: Record<string, number> = {};
  let match: RegExpExecArray | null;
  while ((match = structRe.exec(wasmText))) {
    const name = match[1];
    structNames[name] = (structNames[name] ?? 0) + 1;
  }

  const constructorRe = /struct\.new \$([^\s()]+)/g;
  const constructorCounts: Record<string, number> = {};
  while ((match = constructorRe.exec(wasmText))) {
    const name = match[1];
    constructorCounts[name] = (constructorCounts[name] ?? 0) + 1;
  }

  const optionalStructs = Object.entries(structNames)
    .filter(([name]) => name.startsWith("Some#") || name.startsWith("None#"))
    .sort(([a], [b]) => a.localeCompare(b));

  console.log("\nWasm Optional structs:");
  optionalStructs.forEach(([name, count]) => {
    const parent = lookupParent(name);
    console.log(
      `  ${name} (struct defs: ${count}, new calls: ${
        constructorCounts[name] ?? 0
      }) parent=${parent ?? "unknown"}`
    );
  });
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
