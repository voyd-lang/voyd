import { ObjectType, Type } from "../../syntax-objects/types.js";

export type ReconcileGenericInstancesOptions = {
  canonicalizeType?: (type: Type | undefined) => Type | undefined;
  resolveCanonicalInstance?: (instance: ObjectType) => ObjectType | undefined;
};

export type ReconcileGenericInstancesResult = {
  canonicalInstances: ObjectType[];
  orphans: Array<{ orphan: ObjectType; canonical: ObjectType }>;
};

type OrphanRecord = { orphan: ObjectType; canonical: ObjectType };

const defaultCanonicalizeType = (type: Type | undefined): Type | undefined =>
  type;

const identityInstanceResolver = (
  instance: ObjectType
): ObjectType | undefined => instance;

export const reconcileGenericInstances = (
  parent: ObjectType,
  rawInstances: (ObjectType | undefined)[],
  options: ReconcileGenericInstancesOptions = {}
): ReconcileGenericInstancesResult => {
  const canonicalizeType = options.canonicalizeType ?? defaultCanonicalizeType;
  const resolveCanonicalInstance =
    options.resolveCanonicalInstance ?? identityInstanceResolver;

  const typeKeyCache = new WeakMap<Type, string>();
  let typeKeyCounter = 0;

  const keyForType = (type: Type | undefined): string => {
    if (!type) return "∅";
    const canonical = canonicalizeType(type) ?? type;
    if (typeKeyCache.has(canonical)) {
      return typeKeyCache.get(canonical)!;
    }
    const id = (canonical as any).id;
    if (typeof id === "string" && id.length) {
      typeKeyCache.set(canonical, id);
      return id;
    }
    const name = (canonical as any).name?.toString?.();
    if (typeof name === "string" && name.length) {
      typeKeyCache.set(canonical, name);
      return name;
    }
    const assigned = `type#${typeKeyCounter++}`;
    typeKeyCache.set(canonical, assigned);
    return assigned;
  };

  const keyForArgs = (instance: ObjectType): string => {
    const args = instance.appliedTypeArgs ?? [];
    if (!args.length) return "[]";
    const parts = args.map((arg) => keyForType(arg));
    return `[${parts.join(",")}]`;
  };

  const canonicalInstances: ObjectType[] = [];
  const canonicalByKey = new Map<string, ObjectType>();
  const seen = new Set<ObjectType>();
  const orphans: OrphanRecord[] = [];

  rawInstances.forEach((candidate) => {
    if (!candidate) return;
    const canonical = resolveCanonicalInstance(candidate);
    if (!canonical) return;

    if (canonical !== candidate) {
      orphans.push({ orphan: candidate, canonical });
    }

    const canonicalArgs = canonical.appliedTypeArgs?.map((arg) =>
      canonicalizeType(arg)
    );
    if (canonicalArgs?.length) {
      canonical.appliedTypeArgs = canonicalArgs.filter(
        (arg): arg is Type => !!arg
      );
    }

    canonical.genericParent = parent;

    if (seen.has(canonical)) return;
    seen.add(canonical);

    const key = keyForArgs(canonical);
    const existing = canonicalByKey.get(key);
    if (existing) {
      if (existing === canonical) return;
      orphans.push({ orphan: canonical, canonical: existing });
      return;
    }

    canonicalByKey.set(key, canonical);
    canonicalInstances.push(canonical);
  });

  parent.genericInstances = canonicalInstances;

  return { canonicalInstances, orphans };
};
