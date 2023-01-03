let max = 0;
export function isCyclic(obj: any, count = 0): boolean {
  if (count > max) {
    console.error(`New max found ${count}`);
    max = count;
  }
  if (count > 75) return true;
  if (!obj) return false;
  const parent = obj.parent;
  if (parent) return isCyclic(parent, count + 1);
  return false;
}
