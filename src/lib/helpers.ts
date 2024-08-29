export function isCyclic(obj: any, count = 0): boolean {
  if (count > 75) return true;
  if (!obj) return false;
  const parent = obj.parent;
  if (parent) return isCyclic(parent, count + 1);
  return false;
}
