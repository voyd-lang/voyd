import { registerModules } from "../modules.js";
import { List } from "../../syntax-objects/list.js";
import { stdPath } from "../../parser/index.js";
import { test } from "vitest";
import { RootModule, VoydModule } from "../../syntax-objects/module.js";
import { Fn } from "../../syntax-objects/fn.js";
import { resolveModulePath } from "../resolution/resolve-use.js";

test("module registration", (t) => {
  const result = registerModules(input);
  t.expect(result).toMatchSnapshot();
});

test("resolveModulePath handles import variants", (t) => {
  const root = new RootModule({});
  const std = new VoydModule({ name: "std", parent: root });
  const linearMem = new VoydModule({ name: "linear_memory", parent: std });

  const grow = new Fn({ name: "grow", parent: linearMem });
  const store = new Fn({ name: "store", parent: linearMem });
  const load = new Fn({ name: "load_i32", parent: linearMem });

  linearMem.registerExport(grow);
  linearMem.registerExport(store);
  linearMem.registerExport(load);

  std.registerEntity(linearMem);
  std.registerExport(linearMem);
  root.registerEntity(std);
  root.registerExport(std);

  const multiPath = new List([
    "::",
    new List(["::", "std", "linear_memory"]),
    new List([
      "object",
      new List([":", "grow", "grow_linear_mem"]),
      "store",
      "load_i32",
    ]),
  ]);
  multiPath.parent = root;
  const multiEntities = resolveModulePath(multiPath);
  t.expect(multiEntities.map((e) => e.e.name.value)).toEqual([
    "grow",
    "store",
    "load_i32",
  ]);
  t.expect(multiEntities[0].alias).toBe("grow_linear_mem");

  const singlePath = new List([
    "::",
    new List(["::", "std", "linear_memory"]),
    "grow",
  ]);
  singlePath.parent = root;
  const singleEntities = resolveModulePath(singlePath);
  t.expect(singleEntities[0].e).toBe(grow);

  const modulePath = new List(["::", "std", "linear_memory"]);
  modulePath.parent = root;
  const moduleEntities = resolveModulePath(modulePath);
  t.expect(moduleEntities[0].e).toBe(linearMem);
});

const input = {
  files: {
    "/Users/drew/projects/voyd/example.voyd": new List({
      value: [
        "ast",
        ["use", ["::", ["::", "std", "macros"], "all"]],
        [
          "fn",
          ["fib", [":", "n", "i32"]],
          "->",
          "i32",
          [
            "block",
            [
              "if",
              ["<=", "n", 1],
              [":", "then", ["block", "n"]],
              [
                ":",
                "else",
                [
                  "block",
                  ["+", ["fib", ["-", "n", 1]], ["fib", ["-", "n", 2]]],
                ],
              ],
            ],
          ],
        ],
        [
          "fn",
          ["main"],
          [
            "block",
            ["let", ["=", "x", ["+", 10, ["block", ["+", 20, 30]]]]],
            [
              "let",
              [
                "=",
                "y",
                [
                  "if",
                  [">", "x", 10],
                  [":", "then", ["block", 10]],
                  [":", "else", ["block", 20]],
                ],
              ],
            ],
            [
              "call",
              "this",
              "while",
              [
                "=>",
                [],
                [
                  "if",
                  [">", "x", 10],
                  [":", "then", ["block", ["-=", "x", 1]]],
                  [":", "else", ["block", ["+=", "x", 1]]],
                ],
              ],
            ],
            [
              "let",
              [
                "=",
                "n",
                [
                  "if",
                  [">", ["len", "args"], 1],
                  [
                    ":",
                    "then",
                    [
                      "block",
                      ["log", "console", ["string", "Hey there!"]],
                      ["unwrap", ["parseInt", ["at", "args", 1]]],
                    ],
                  ],
                  [":", "else", ["block", 10]],
                ],
              ],
            ],
            ["let", ["=", "x2", 10]],
            ["let", ["=", "z", ["nothing"]]],
            ["let", ["=", "test_spacing", ["fib", "n"]]],
            ["let", ["=", "result", ["fib", "n"]]],
          ],
        ],
      ],
    }),
    [`${stdPath}/deep/nested/hey.voyd`]: new List({
      value: [
        "ast",
        ["use", ["::", ["::", "super", "macros"], "all"]],
        [
          "pub",
          "fn",
          ["hey", [":", "src", "i32"], [":", "dest", "i32"]],
          "->",
          "i32",
          ["block"],
        ],
      ],
    }),
    [`${stdPath}/deep/nested.voyd`]: new List({
      value: [
        "ast",
        ["pub", ["use", ["::", "hey", "all"]]],
        [
          "pub",
          "fn",
          ["nested", [":", "src", "i32"], [":", "dest", "i32"]],
          "->",
          "i32",
          ["block"],
        ],
      ],
    }),
    [`${stdPath}/deep/mod.voyd`]: new List({
      value: [
        "ast",
        ["pub", ["use", ["::", "hey", "all"]]],
        [
          "pub",
          "fn",
          ["deeply", [":", "src", "i32"], [":", "dest", "i32"]],
          "->",
          "i32",
          ["block"],
        ],
      ],
    }),
    [`${stdPath}/memory.voyd`]: new List({
      value: [
        "ast",
        ["use", ["::", ["::", "super", "macros"], "all"]],
        ["global", "let", ["=", "header-size", 8]],
        ["global", "let", ["=", "size-index", 0]],
        ["global", "let", ["=", "type-index", 4]],
        ["global", "var", ["=", "stack-pointer", 0]],
        [
          "pub",
          "fn",
          ["copy", [":", "src", "i32"], [":", "dest", "i32"]],
          "->",
          "i32",
          [
            "block",
            [
              "bnr",
              ["memory", "copy", "voyd"],
              ["dest", "src", ["size", "src"]],
            ],
            "dest",
          ],
        ],
      ],
    }),
    [`${stdPath}/index.voyd`]: new List({
      value: ["ast", ["pub", ["use", ["::", "macros", "all"]]]],
    }),
  },
  srcPath: "/Users/drew/projects/voyd",
  indexPath: "/Users/drew/projects/voyd/index.voyd",
};
