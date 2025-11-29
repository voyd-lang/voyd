// TODO: Add map, filter, reduce, amd findIndex
export class FastShiftArray<T> {
  private items: T[];
  private headIndex: number;

  constructor(...args: T[]) {
    this.items = args;
    this.headIndex = 0;
  }

  private resolveIndex(index: number): number {
    return this.headIndex + (index < 0 ? this.length + index : index);
  }

  shift(): T | undefined {
    if (this.headIndex >= this.items.length) {
      return undefined;
    }
    const value = this.items[this.headIndex];
    this.items[this.headIndex] = undefined as any; // Optional: clear the reference for garbage collection
    this.headIndex++;
    return value;
  }

  push(...items: T[]): number {
    this.items.push(...items);
    return this.length;
  }

  pop(): T | undefined {
    if (this.length === 0) return undefined;
    return this.items.pop();
  }

  unshift(...items: T[]): number {
    this.items.splice(this.headIndex, 0, ...items);
    return this.length;
  }

  at(index: number): T | undefined {
    return this.items[this.resolveIndex(index)];
  }

  set(index: number, value: T): boolean {
    const actual = this.resolveIndex(index);
    if (actual < this.headIndex || actual >= this.items.length) {
      return false; // Index out of bounds
    }
    this.items[actual] = value;
    return true;
  }

  get length(): number {
    return this.items.length - this.headIndex;
  }

  slice(start?: number, end?: number): T[] {
    const actualStart =
      start !== undefined ? this.resolveIndex(start) : this.headIndex;
    const actualEnd =
      end !== undefined ? this.resolveIndex(end) : this.items.length;
    return this.items.slice(actualStart, actualEnd);
  }

  splice(start: number, deleteCount: number = 0, ...items: T[]): T[] {
    const actualStart = this.resolveIndex(start);
    return this.items.splice(actualStart, deleteCount, ...items);
  }

  // Converts the FastShiftArray back to a normal array
  toArray(): T[] {
    return this.items.slice(this.headIndex);
  }

  // Optional: Method to reset the headIndex
  resetShift(): void {
    this.items.splice(0, this.headIndex);
    this.headIndex = 0;
  }

  forEach(callbackfn: (value: T, index: number, array: T[]) => void): void {
    this.items.slice(this.headIndex).forEach(callbackfn);
  }

  find(
    predicate: (value: T, index: number, array: T[]) => boolean
  ): T | undefined {
    const array = this.toArray();
    for (let index = 0; index < array.length; index++) {
      const value = array[index];
      if (predicate(value, index, array)) return value;
    }
    return undefined;
  }

  reverseFind(
    predicate: (value: T, index: number, array: T[]) => boolean
  ): T | undefined {
    const array = this.toArray();
    for (let index = array.length - 1; index >= 0; index--) {
      const value = array[index];
      if (predicate(value, index, array)) return value;
    }
    return undefined;
  }
}
