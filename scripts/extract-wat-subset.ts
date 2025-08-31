// extract-wat-subset.ts
//
// Adds --max-depth N to limit transitive function deps:
//   0 = only the seed function(s)
//   1 = seed + their direct callees
//   2 = ... and callees-of-callees, etc.
// Types used by the included functions are always closed transitively.
//
// Usage:
//   ts-node extract-wat-subset.ts --file input.wat --func $main#104299 --max-depth 1 > subset.wat
//
// Other options:
//   --wrap-module
//   --allow-unnamed-funcs

import * as fs from "fs";
import * as path from "path";

type NodeKind = "func" | "type";
type NodeDef = { kind: NodeKind; name: string; text: string; order: number };

type CLI = {
  file: string;
  funcNames: string[];
  wrapModule: boolean;
  allowUnnamedFuncs: boolean;
  maxDepth: number; // Infinity if omitted
};

function parseCLI(argv: string[]): CLI {
  const out: CLI = {
    file: "",
    funcNames: [],
    wrapModule: false,
    allowUnnamedFuncs: false,
    maxDepth: Number.POSITIVE_INFINITY,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file" && argv[i + 1]) {
      out.file = argv[++i];
    } else if ((a === "--func" || a === "-f") && argv[i + 1]) {
      let name = argv[++i];
      if (!name.startsWith("$")) name = "$" + name;
      out.funcNames.push(name);
    } else if (a === "--wrap-module") {
      out.wrapModule = true;
    } else if (a === "--allow-unnamed-funcs") {
      out.allowUnnamedFuncs = true;
    } else if ((a === "--max-depth" || a === "-d") && argv[i + 1]) {
      const v = Number(argv[++i]);
      out.maxDepth = Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
    } else if (a === "-h" || a === "--help") {
      printHelpAndExit();
    }
  }
  if (!out.file || out.funcNames.length === 0)
    printHelpAndExit("Missing --file and/or --func");
  return out;
}

function printHelpAndExit(msg?: string): never {
  if (msg) console.error("Error:", msg);
  console.error(`
Extract a dependency-closed set of (func ...) + (type ...) from a WAT file,
with an optional max call depth.

Usage:
  ts-node extract-wat-subset.ts --file input.wat --func $main#104299 --max-depth 1 > out.wat

Options:
  --file <path>             Input .wat
  --func <name>             Starting function (repeatable). Accepts with/without '$'
  --max-depth <n>           0 = only seeds, 1 = seeds + direct callees, etc. Default: ∞
  --wrap-module             Wrap output in (module ...)
  --allow-unnamed-funcs     Keep unnamed funcs (assigns surrogate names)
`);
  process.exit(msg ? 1 : 0);
}

// -------- comment stripping (line ";;" and nested "(; ;)") ------
function stripComments(wat: string): string {
  let i = 0,
    n = wat.length,
    out = "",
    inStr = false,
    blockDepth = 0,
    inLine = false;
  while (i < n) {
    const ch = wat[i];
    if (blockDepth > 0) {
      if (ch === "(" && wat[i + 1] === ";") {
        blockDepth++;
        i += 2;
        continue;
      }
      if (ch === ";" && wat[i + 1] === ")") {
        blockDepth--;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      i++;
      continue;
    }
    if (!inStr) {
      if (ch === "(" && wat[i + 1] === ";") {
        blockDepth = 1;
        i += 2;
        continue;
      }
      if (ch === ";" && wat[i + 1] === ";") {
        inLine = true;
        i += 2;
        continue;
      }
      if (ch === '"') {
        inStr = true;
        out += ch;
        i++;
        continue;
      }
      out += ch;
      i++;
    } else {
      out += ch;
      if (ch === "\\") {
        if (i + 1 < n) {
          out += wat[i + 1];
          i += 2;
          continue;
        }
      }
      if (ch === '"') inStr = false;
      i++;
    }
  }
  return out;
}

// ---------- small helpers ----------
const isWS = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";
function peekWordIn(str: string, start: number): string {
  let j = start;
  while (j < str.length && isWS(str[j])) j++;
  let k = j;
  while (k < str.length && /[A-Za-z0-9._\-]/.test(str[k])) k++;
  return str.slice(j, k);
}
function captureSExprIn(
  str: string,
  startIndex: number
): { text: string; endIndex: number } {
  let j = startIndex,
    d = 0,
    inStr = false;
  while (j < str.length) {
    const ch = str[j];
    if (!inStr) {
      if (ch === '"') {
        inStr = true;
        j++;
        continue;
      }
      if (ch === "(") d++;
      else if (ch === ")") {
        d--;
        if (d === 0)
          return { text: str.slice(startIndex, j + 1), endIndex: j + 1 };
      }
      j++;
    } else {
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === '"') inStr = false;
      j++;
    }
  }
  return { text: str.slice(startIndex), endIndex: str.length };
}
function extractNameFromFunc(text: string): string | null {
  const m = /^\(\s*func\b\s+(\$[^\s()]+)/.exec(text.trimStart());
  return m ? m[1] : null;
}
function extractNameFromType(text: string): string | null {
  const m = /^\(\s*type\b\s+(\$[^\s()]+)/.exec(text.trimStart());
  return m ? m[1] : null;
}

// ---------- module-aware collectors ----------
let ALLOW_UNNAMED_FUNCS = false;
let unnamedFuncCounter = 1;

function collectTopLevelDefs(cleanWat: string): {
  funcs: Map<string, NodeDef>;
  types: Map<string, NodeDef>;
} {
  const funcs = new Map<string, NodeDef>();
  const types = new Map<string, NodeDef>();
  let orderCounter = 0;

  function addDef(kind: NodeKind, name: string | null, text: string) {
    if (kind === "func") {
      if (name) {
        funcs.set(name, { kind, name, text, order: orderCounter++ });
      } else if (ALLOW_UNNAMED_FUNCS) {
        const surrogate = `$__unnamed_func_${unnamedFuncCounter++}`;
        funcs.set(surrogate, {
          kind,
          name: surrogate,
          text,
          order: orderCounter++,
        });
      }
    } else if (kind === "type") {
      if (name) {
        types.set(name, { kind, name, text, order: orderCounter++ });
      }
    }
  }

  // scan each top-level (module ...)
  let i = 0,
    depth = 0,
    inStr = false,
    foundModule = false;
  while (i < cleanWat.length) {
    const ch = cleanWat[i];
    if (!inStr) {
      if (ch === '"') {
        inStr = true;
        i++;
        continue;
      }
      if (ch === "(") {
        const word = peekWordIn(cleanWat, i + 1);
        if (depth === 0 && word === "module") {
          const { text: moduleText, endIndex } = captureSExprIn(cleanWat, i);
          foundModule = true;
          // walk direct children
          let j = 0,
            d = 0,
            inMStr = false;
          while (j < moduleText.length) {
            const ch2 = moduleText[j];
            if (!inMStr) {
              if (ch2 === '"') {
                inMStr = true;
                j++;
                continue;
              }
              if (ch2 === "(") {
                const w2 = peekWordIn(moduleText, j + 1);
                if (d === 1 && (w2 === "func" || w2 === "type")) {
                  const { text, endIndex: endJ } = captureSExprIn(
                    moduleText,
                    j
                  );
                  if (w2 === "func")
                    addDef("func", extractNameFromFunc(text), text);
                  else addDef("type", extractNameFromType(text), text);
                  j = endJ;
                  continue;
                }
                d++;
                j++;
                continue;
              }
              if (ch2 === ")") {
                d = Math.max(0, d - 1);
                j++;
                continue;
              }
              j++;
            } else {
              if (ch2 === "\\") {
                j += 2;
                continue;
              }
              if (ch2 === '"') inMStr = false;
              j++;
            }
          }
          i = endIndex;
          continue;
        }
        depth++;
      } else if (ch === ")") {
        depth = Math.max(0, depth - 1);
      }
      i++;
    } else {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === '"') inStr = false;
      i++;
    }
  }

  // fallback: no module wrapper — capture at file top-level
  if (!foundModule) {
    i = 0;
    depth = 0;
    inStr = false;
    while (i < cleanWat.length) {
      const ch = cleanWat[i];
      if (!inStr) {
        if (ch === '"') {
          inStr = true;
          i++;
          continue;
        }
        if (ch === "(") {
          const word = peekWordIn(cleanWat, i + 1);
          if (depth === 0 && (word === "func" || word === "type")) {
            const { text, endIndex } = captureSExprIn(cleanWat, i);
            if (word === "func")
              addDef("func", extractNameFromFunc(text), text);
            else addDef("type", extractNameFromType(text), text);
            i = endIndex;
            continue;
          }
          depth++;
        } else if (ch === ")") depth = Math.max(0, depth - 1);
        i++;
      } else {
        if (ch === "\\") {
          i += 2;
          continue;
        }
        if (ch === '"') inStr = false;
        i++;
      }
    }
  }

  return { funcs, types };
}

// ---------- dependency walk (depth-limited for functions) ----------
function findReferencedNames(
  text: string,
  funcNames: Set<string>,
  typeNames: Set<string>
) {
  const tokenRegex = /\$[^\s()]+/g;
  const rf = new Set<string>(),
    rt = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = tokenRegex.exec(text))) {
    const tok = m[0];
    if (funcNames.has(tok)) rf.add(tok);
    if (typeNames.has(tok)) rt.add(tok);
  }
  return { funcs: rf, types: rt };
}
function sortByOrder<T extends { order: number }>(xs: T[]) {
  return xs.slice().sort((a, b) => a.order - b.order);
}

function main() {
  const cli = parseCLI(process.argv);
  ALLOW_UNNAMED_FUNCS = cli.allowUnnamedFuncs;

  const input = fs.readFileSync(path.resolve(cli.file), "utf8");
  const clean = stripComments(input);
  const { funcs, types } = collectTopLevelDefs(clean);

  const allFuncNames = new Set(funcs.keys());
  const allTypeNames = new Set(types.keys());

  // seed queue with depth 0
  type QItem = { name: string; depth: number };
  const queue: QItem[] = [];
  const visitedDepth = new Map<string, number>();
  for (const f of cli.funcNames) {
    if (!allFuncNames.has(f)) {
      console.error(`Warning: function ${f} not found at module top-level.`);
      continue;
    }
    queue.push({ name: f, depth: 0 });
    visitedDepth.set(f, 0);
  }

  const selectedFuncs = new Set<string>();
  const selectedTypes = new Set<string>();

  while (queue.length) {
    const { name, depth } = queue.pop()!;
    if (depth > cli.maxDepth) continue;
    if (selectedFuncs.has(name)) continue;
    selectedFuncs.add(name);

    const fdef = funcs.get(name);
    if (!fdef) continue;

    const refs = findReferencedNames(fdef.text, allFuncNames, allTypeNames);

    // enqueue callees within depth
    for (const g of refs.funcs) {
      const nd = depth + 1;
      if (nd > cli.maxDepth) continue;
      const prev = visitedDepth.get(g);
      if (prev === undefined || nd < prev) {
        visitedDepth.set(g, nd);
        queue.push({ name: g, depth: nd });
      }
    }

    // collect types used by this included function
    for (const t of refs.types) selectedTypes.add(t);
  }

  // close over type->type references (types are always closed transitively)
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of Array.from(selectedTypes)) {
      const tdef = types.get(t);
      if (!tdef) continue;
      const tref = findReferencedNames(
        tdef.text,
        new Set(),
        allTypeNames
      ).types;
      for (const t2 of tref) {
        if (!selectedTypes.has(t2)) {
          selectedTypes.add(t2);
          grew = true;
        }
      }
    }
  }

  const typeDefs = sortByOrder(
    Array.from(selectedTypes)
      .map((n) => types.get(n)!)
      .filter(Boolean)
  );
  const funcDefs = sortByOrder(
    Array.from(selectedFuncs)
      .map((n) => funcs.get(n)!)
      .filter(Boolean)
  );

  let out = "";
  if (cli.wrapModule) out += "(module\n";
  for (const t of typeDefs) out += t.text + "\n";
  for (const f of funcDefs) out += f.text + "\n";
  if (cli.wrapModule) out += ")\n";
  process.stdout.write(out);
}

main();
