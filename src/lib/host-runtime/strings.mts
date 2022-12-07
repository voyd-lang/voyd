import { boolToInt } from "./bool-to-int.mjs";

export class StringsTable {
  readonly rotateAfterIndex = 500000;
  readonly strings = new Map<number, string>();
  nextStringIndex = 0;

  private getNextIndex() {
    const index = this.nextStringIndex;

    if (this.nextStringIndex >= this.rotateAfterIndex) {
      this.nextStringIndex = 0;
      return index;
    }

    this.nextStringIndex += 1;
    return index;
  }

  allocString(): number {
    const index = this.getNextIndex();
    this.strings.set(index, "");
    return index;
  }

  deAllocString(index: number) {
    this.strings.delete(index);
  }

  strLength(index: number) {
    return this.strings.get(index)?.length ?? -1;
  }

  printStr(index: number) {
    console.log(this.strings.get(index));
  }

  addCharCodeToString(code: number, index: number) {
    const str = this.strings.get(index) ?? "";
    this.strings.set(index, str + String.fromCharCode(code));
  }

  getCharCodeFromString(charIndex: number, strIndex: number) {
    return this.strings.get(strIndex)?.[charIndex] ?? -1;
  }

  strEquals(aIndex: number, bIndex: number): number {
    return boolToInt(this.strings.get(aIndex) === this.strings.get(bIndex));
  }

  strStartsWith(aIndex: number, bIndex: number): number {
    return boolToInt(
      !!this.strings.get(aIndex)?.startsWith(this.strings.get(bIndex) ?? "") // this could probably cause bugs FYI, consider returning false if either string doesn't exist
    );
  }

  strEndsWith(aIndex: number, bIndex: number): number {
    return boolToInt(
      !!this.strings.get(aIndex)?.endsWith(this.strings.get(bIndex) ?? "") // this could probably cause bugs FYI, consider returning false if either string doesn't exist
    );
  }

  strIncludes(aIndex: number, bIndex: number): number {
    return boolToInt(
      !!this.strings.get(aIndex)?.endsWith(this.strings.get(bIndex) ?? "") // this could probably cause bugs FYI, consider returning false if either string doesn't exist
    );
  }

  /** Pass -1 for default flags (g) */
  strTest(strIndex: number, regexIndex: number, flagsIndex: number): number {
    const str = this.strings.get(strIndex);
    const regex = this.strings.get(regexIndex);
    const flags = flagsIndex !== -1 ? this.strings.get(flagsIndex) : "g";
    if (str === undefined || regex === undefined) return 0;
    return boolToInt(new RegExp(regex, flags).test(str));
  }
}
