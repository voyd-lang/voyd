import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { parse } from "../parser.js";

type DocumentedSnippet = {
  id: string;
  filePath: string;
  source: string;
};

type SyntaxShapeCase = {
  id: string;
  source: string;
};

const referenceDocsRoot = resolve(
  import.meta.dirname,
  "../../../../reference/docs"
);

// Release notes preserve examples written for older language versions. Current
// reference pages are the public inventory this parser contract intentionally
// follows.
const currentReferenceFiles = markdownFiles(referenceDocsRoot).filter(
  (filePath) => relative(referenceDocsRoot, filePath) !== "releases.md"
);
const documentedSnippets = currentReferenceFiles.flatMap((filePath) =>
  extractVoydSnippets(filePath)
);

describe("documented Voyd syntax contract", () => {
  test("covers the full current reference corpus", () => {
    expect(documentedSnippets.length).toBeGreaterThanOrEqual(250);
  });

  test("parses every current reference example", () => {
    const failures = documentedSnippets.flatMap(({ id, filePath, source }) => {
      try {
        parse(source, filePath);
        return [];
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return [`${id}: ${message}`];
      }
    });

    expect(failures).toEqual([]);
  });
});

// These cases preserve the grouping-sensitive AST contract that is most useful
// while changing the parser. They complement the broad reference acceptance
// corpus with compact, named snapshots whose diffs identify the affected syntax
// family.
const syntaxShapeCases: SyntaxShapeCase[] = [
  {
    id: "calls, labels, generics, and trailing closures",
    source: `
fn calls(value: i32)
  fib value - 1
  dispatch<i32> event: value priority: value + 1
  fib(value - 1, label: value)
  fib<i32>(value - 1, value)
  fib<i32>((value - 1, value))
  values.reduce(initial: 0) (acc, item) =>
    acc + item
  hi there(what): is(up)
`,
  },
  {
    id: "operator precedence, pipes, optional access, and ranges",
    source: `
fn operators(a: i32, b: i32, c: i32)
  let arithmetic = a + b * c ^ 2
  let piped = a |> transform |> finish
  let fallback = value?.field ?? default_value
  let exclusive = values[1..<4]
  let inclusive = values[..=4]
  values[..]
  10
  + 3
`,
  },
  {
    id: "indentation, blocks, and control-flow clauses",
    source: `
fn control(value: i32)
  if value < 0 then:
    -1
  elif value == 0 then:
    0
  else:
    match(value)
      Some<i32> { value: inner }:
        while inner > 0:
          consume(inner)
      else:
        for item in 0..<value:
          consume(item)
`,
  },
  {
    id: "bindings, lambdas, tuples, arrays, and object literals",
    source: `
fn values(input: i32)
  let (left, right) = (input, input + 1)
  let ~owned = acquire()
  let items = [left, right, ...rest]
  let record = { left, right: transform(right), ...base }
  let expanded = ...input.items + other.value
  let callback = (value: i32, index: i32) => value + index
  callback(record.left, 0)
`,
  },
  {
    id: "multiline call separators and closure arguments",
    source: `
fn closure_arguments()
  let result = invoke(
    add 1 2,
    () =>
      first()
    ,
    3 + 4
  )

  consume_many(1, () => first(), 3, () =>
    second(),
    4,
    () => 5,
    () =>
      6,
    () =>
      7
    ,
    8
  )
`,
  },
  {
    id: "multiple labeled callback clauses",
    source: `
fn callbacks(values: Values)
  values.reduce(initial: 0)
    on_value(acc, item):
      acc + item
    on_empty():
      0

  values.reduce(0, 1, 2) success: () =>
    finish()
  failure: () => recover()
`,
  },
  {
    id: "declarations, generic constraints, and effect rows",
    source: `
type Pair<T> = (T, T)
obj Box<T: Display> { value: T }

trait Map<Input, Output>
  fn map(self, transform: fn(Input) : (open) -> Output) : (open) -> Output

eff Console
  op write(message: String) -> void

fn apply<T: Display>(value: T, transform: fn(T) : (open) -> T) : (open) -> T
  transform(value)
`,
  },
  {
    id: "module imports, aliases, and qualified access",
    source: `
use std::collections::{ Array, Map as HashMap }
use std::io::all
pub use app::model::User

mod nested
  pub fn value() -> i32 = 1

fn access(receiver: Value)
  nested::value()
  receiver.Display::to_string()
  Package::Type::member(receiver)
`,
  },
  {
    id: "newline fluent clauses and nested generic match heads",
    source: `
fn chained(values: Values)
  values
    .pop()
    .match(item)
      Some<Optional<i32>>:
        item.value
      None:
        None {}
    .match(item)
      Some<i32>:
        item.value
      None:
        -1
`,
  },
  {
    id: "dot-lambda chaining",
    source: `
fn transform() -> i32
  2
    .(value: i32) => value + 3
    .(value: i32) => value * 5
`,
  },
  {
    id: "string interpolation and HTML reader syntax",
    source: `
fn view(name: String, active: bool)
  let greeting = "Hello {name}!"
  <section hidden class="card" data-active={active}>
    <h1>{greeting}</h1>
    <Button key={name} onClick={() => select(name)}>
      Choose
    </Button>
  </section>
`,
  },
  {
    id: "macro template splice forms",
    source: `
fn template_surface()
  $value
  $(value)
  $$values
  $$(values)
  (block $body)
`,
  },
  {
    id: "attributes, tests, and compiler-facing declarations",
    source: `
@effect(id: "example.console")
eff Console
  op log(message: String) -> void

@intrinsic(name: "i32.add")
fn intrinsic_add(left: i32, right: i32) -> i32

test "syntax contract"
  assert(true)
`,
  },
];

describe("Voyd syntax shape contract", () => {
  test.each(syntaxShapeCases)("preserves $id", ({ source }) => {
    expect(toPlainAst(source)).toMatchSnapshot();
  });
});

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? markdownFiles(path) : [path];
    })
    .filter((path) => path.endsWith(".md"))
    .sort();
}

function extractVoydSnippets(filePath: string): DocumentedSnippet[] {
  const markdown = readFileSync(filePath, "utf8");
  const relativePath = relative(referenceDocsRoot, filePath);
  const matches = [...markdown.matchAll(/```voyd\s*\n([\s\S]*?)```/g)];

  return matches.map((match, index) => ({
    id: `${relativePath} #${index + 1} (${headingBefore(markdown, match.index)})`,
    filePath: `${filePath}#voyd-${index + 1}`,
    source: match[1],
  }));
}

function headingBefore(markdown: string, index: number | undefined): string {
  const precedingText = markdown.slice(0, index);
  const headings = [...precedingText.matchAll(/^#{1,6}\s+(.+)$/gm)];
  return headings.at(-1)?.[1] ?? "Introduction";
}

function toPlainAst(source: string): unknown {
  return JSON.parse(JSON.stringify(parse(source).toJSON()));
}
