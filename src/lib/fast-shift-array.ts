import { at } from "vitest/dist/chunks/reporters.C_zwCd4j.js";

// TODO: Add map, filter, reduce, amd findIndex
export class FastShiftArray<T> {
  private items: T[];
  private headIndex: number;

  constructor(...args: T[]) {
    this.items = args;
    this.headIndex = 0;
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
    if (index < 0) {
      index = this.length + index;
    }
    return this.items[this.headIndex + index];
  }

  set(index: number, value: T): boolean {
    const targetIndex = index < 0 ? this.length + index : index;
    if (targetIndex < 0 || targetIndex >= this.length) {
      return false; // Index out of bounds
    }
    this.items[this.headIndex + targetIndex] = value;
    return true;
  }

  get length(): number {
    return this.items.length - this.headIndex;
  }

  slice(start?: number, end?: number): T[] {
    const actualStart =
      start !== undefined
        ? this.headIndex + (start < 0 ? this.length + start : start)
        : this.headIndex;
    const actualEnd =
      end !== undefined
        ? this.headIndex + (end < 0 ? this.length + end : end)
        : this.items.length;
    return this.items.slice(actualStart, actualEnd);
  }

  splice(start: number, deleteCount: number = 0, ...items: T[]): T[] {
    const actualStart =
      this.headIndex + (start < 0 ? this.length + start : start);
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

  forEach(callbackfn: (value: T, index: number, array: T[]) => voyd): void {
    this.items.slice(this.headIndex).forEach(callbackfn);
  }
}
