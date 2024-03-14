export const isTerminator = (char: string) =>
  isWhitespace(char) ||
  char === "," ||
  isBracket(char) ||
  isQuote(char) ||
  isOpChar(char);

export const isQuote = newTest(["'", '"', "`"]);

export const isWhitespace = (char: string) => /\s/.test(char);

export const isBracket = newTest(["{", "[", "(", ")", "]", "}"]);

export const isOpChar = newTest([
  "+",
  "-",
  "*",
  "/",
  "=",
  ":",
  "?",
  ".",
  ";",
  "<",
  ">",
  "$",
  "!",
  "@",
  "%",
  "^",
  "&",
  "~",
  "\\",
  "#",
]);

export const isDigit = (char: string) => /[0-9]/.test(char);
export const isDigitSign = (char: string) => char === "+" || char === "-";

function newTest<T>(list: Set<T> | Array<T>) {
  const set = new Set(list);
  return (val: T) => set.has(val);
}
