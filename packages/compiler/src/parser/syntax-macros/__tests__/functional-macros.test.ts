import { describe, expect, test } from "vitest";
import { parse, parseBase } from "../../parser.js";
import {
  Form,
  identifierBindingKey,
  isForm,
  isIdentifierAtom,
} from "../../ast/index.js";
import { readFileSync } from "fs";
import { resolve } from "path";
import { expandFunctionalMacros } from "../functional-macro-expander/index.js";

type Plain = (string | Plain)[];

const functionalMacrosVoydFile = readFileSync(
  resolve(import.meta.dirname, "__fixtures__", "functional_macros.voyd"),
  "utf-8",
);
const enumMacroVoydFile = readFileSync(
  resolve(import.meta.dirname, "../../../../../std/src/enums.voyd"),
  "utf-8",
);

const toPlain = (form: Form): Plain =>
  JSON.parse(JSON.stringify(form.toJSON()));

const containsDeep = (value: unknown, target: unknown): boolean => {
  if (Array.isArray(value) && Array.isArray(target)) {
    if (JSON.stringify(value) === JSON.stringify(target)) return true;
  }

  if (Array.isArray(value)) {
    return value.some((item) => containsDeep(item, target));
  }

  if (value && typeof value === "object") {
    return Object.values(value).some((item) => containsDeep(item, target));
  }

  return false;
};

describe("functional macro expansion", () => {
  test("gives enum variants private identities independent of display spelling", () => {
    const ast = parse(
      `${enumMacroVoydFile}\n\nenum First\n  Ready\n  Done\n\nenum Second\n  Ready\n  Done\n`,
    );
    const objectNames = ast.rest.flatMap((entry) => {
      if (!isForm(entry) || !entry.calls("obj")) return [];
      const name = entry.at(1);
      return isIdentifierAtom(name) ? [name] : [];
    });
    expect(objectNames.map((entry) => entry.value)).toEqual([
      "Ready",
      "Done",
      "Ready",
      "Done",
    ]);
    const keys = objectNames.map(identifierBindingKey);
    expect(new Set(keys).size).toBe(4);
    expect(JSON.stringify(ast.toJSON())).not.toContain("fresh:");
  });
  test("creates deterministic, opaque identities for fresh identifiers", () => {
    const source = `\
macro generated_ids()
  let first = identifier("same_label")
  let second = identifier("same_label")
  \`($first $first $second)
generated_ids()
`;

    const firstExpansion = parse(source);
    const secondExpansion = parse(source);
    const readKeys = (ast: Form) => {
      const expansion = ast.last;
      expect(isForm(expansion)).toBe(true);
      if (!isForm(expansion)) return [];
      const identifiers = expansion
        .toArray()
        .filter((entry) => isIdentifierAtom(entry));
      expect(identifiers.map((entry) => entry.value)).toEqual([
        "same_label",
        "same_label",
        "same_label",
      ]);
      return identifiers.map(identifierBindingKey);
    };

    const firstKeys = readKeys(firstExpansion);
    expect(firstKeys[0]).toBe(firstKeys[1]);
    expect(firstKeys[0]).not.toBe(firstKeys[2]);
    expect(readKeys(secondExpansion)).toEqual(firstKeys);
    expect(JSON.stringify(firstExpansion.toJSON())).not.toContain("fresh:");
  });

  test("keeps fresh declarations private when generated with public visibility", () => {
    const ast = parse(`\
macro declare_private()
  let name = identifier("debug_helper")
  \`(pub fn $name() -> i32 1)
declare_private()
`);
    const declaration = ast.last;
    expect(isForm(declaration)).toBe(true);
    if (!isForm(declaration)) return;
    expect(declaration.calls("fn")).toBe(true);
    const signature = declaration.at(1);
    expect(isForm(signature)).toBe(true);
    if (!isForm(signature)) return;
    const callable = signature.calls("->") ? signature.at(1) : signature;
    const name = isForm(callable) ? callable.at(0) : callable;
    expect(isIdentifierAtom(name)).toBe(true);
    if (!isIdentifierAtom(name)) return;
    expect(identifierBindingKey(name)).toMatch(/^fresh:/);
  });

  test("keeps fresh module values and nested API members private", () => {
    const valueAst = parse(`\
macro declare_value()
  let name = identifier("debug_value")
  \`(pub let $name = 1)
declare_value()
`);
    expect(valueAst.last?.toJSON()).toEqual(["let", ["=", "debug_value", "1"]]);

    const objectAst = parse(`\
macro declare_container()
  let field = identifier("debug_field")
  let method = identifier("debug_method")
  \`(obj Container {
    api $field: i32
    api fn $method(self) -> i32
      1
  })
declare_container()
`);
    const declaration = objectAst.last;
    expect(isForm(declaration)).toBe(true);
    const plain = declaration?.toJSON();
    expect(JSON.stringify(plain)).not.toContain('"api"');
    expect(containsDeep(plain, [":", "debug_field", "i32"])).toBe(true);
    expect(containsDeep(plain, ["->", ["debug_method", "self"], "i32"])).toBe(
      true,
    );
  });

  test("keeps every fresh grouped-use alias private", () => {
    const ast = parse(`\
macro expose_helpers()
  let hidden = identifier("hidden_helper")
  \`(pub use src::tools::{ helper as visible_helper, helper as $hidden })
expose_helpers()
`);

    expect(ast.last?.toJSON()).toEqual([
      "use",
      [
        "::",
        ["::", "src", "tools"],
        [
          "object_literal",
          ["as", "helper", "visible_helper"],
          ["as", "helper", "hidden_helper"],
        ],
      ],
    ]);
  });

  test("keeps public effects and traits private when they contain fresh members", () => {
    const ast = parse(`\
macro declare_containers()
  let operation = identifier("hidden_operation")
  let method = identifier("hidden_method")
  emit_many(
    \`(pub eff PublicFx
      fn $operation(tail) -> i32),
    \`(pub trait PublicTrait
      fn $method(self) -> i32)
  )
declare_containers()
`);

    const declarations = ast.rest.slice(-2);
    expect(declarations.map((entry) => entry.toJSON())).toEqual([
      [
        "eff",
        "PublicFx",
        [
          "block",
          ["fn", ["->", ["hidden_operation", "tail"], "i32"]],
        ],
      ],
      [
        "trait",
        "PublicTrait",
        ["block", ["fn", ["->", ["hidden_method", "self"], "i32"]]],
      ],
    ]);
  });

  test("keeps fresh declarations private after attribute expansion", () => {
    const ast = parse(`\
attribute macro replace(args, declaration)
  let name = identifier("attribute_helper")
  \`(pub fn $name() -> i32
    1)

@replace
fn original() -> i32
  0
`);
    const declaration = ast.last;
    expect(isForm(declaration)).toBe(true);
    if (!isForm(declaration)) return;
    expect(declaration.calls("fn")).toBe(true);
    expect(declaration.toJSON()).toEqual([
      "fn",
      ["->", ["attribute_helper"], "i32"],
      ["block", "1"],
    ]);
  });

  test("preserves definition and symbol-reference identifier contexts", () => {
    const source = `\
macro references()
  let direct = symbol_reference(helper)
  let qualified = symbol_reference(tools::helper)
  \`($direct $qualified)
references()
`;

    const ast = parse(source, "macros.voyd");
    const expansion = ast.last;
    expect(isForm(expansion)).toBe(true);
    if (!isForm(expansion)) return;
    const direct = expansion.at(0);
    const qualified = expansion.at(1);
    expect(isIdentifierAtom(direct)).toBe(true);
    if (isIdentifierAtom(direct)) {
      expect(direct.lexicalContext).toMatchObject({
        kind: "symbol-reference",
      });
    }
    expect(isForm(qualified)).toBe(true);
    if (isForm(qualified)) {
      const root = qualified.at(1);
      expect(isIdentifierAtom(root)).toBe(true);
      if (isIdentifierAtom(root)) {
        expect(root.lexicalContext).toMatchObject({
          kind: "symbol-reference",
        });
      }
    }
  });

  test("rejects strings and declaration names in symbol_reference", () => {
    const stringErrors: string[] = [];
    expandFunctionalMacros(
      parseBase(`macro bad()\n  symbol_reference("helper")\nbad()`),
      {
        strictMacroSignatures: true,
        onError: (error) => stringErrors.push(error.message),
      },
    );
    expect(stringErrors).toHaveLength(1);
    expect(stringErrors[0]).toContain(
      "requires an identifier or qualified symbol",
    );

    const declarationErrors: string[] = [];
    expandFunctionalMacros(
      parseBase(`\
macro bad_declaration()
  let ref = symbol_reference(helper)
  \`(fn $ref() -> i32 1)
bad_declaration()
`),
      {
        strictMacroSignatures: true,
        onError: (error) => declarationErrors.push(error.message),
      },
    );
    expect(declarationErrors).toHaveLength(1);
    expect(declarationErrors[0]).toContain(
      "reference-only and cannot be used as a declaration name",
    );

    const publicDeclarationErrors: string[] = [];
    expandFunctionalMacros(
      parseBase(`\
macro bad_public_declaration()
  let ref = symbol_reference(helper)
  \`(pub fn $ref() -> i32 1)
bad_public_declaration()
`),
      {
        strictMacroSignatures: true,
        onError: (error) => publicDeclarationErrors.push(error.message),
      },
    );
    expect(publicDeclarationErrors[0]).toContain(
      "reference-only and cannot be used as a declaration name",
    );

    const parameterErrors: string[] = [];
    expandFunctionalMacros(
      parseBase(`\
macro bad_parameter()
  let ref = symbol_reference(helper)
  \`(fn generated($ref: i32) -> i32 $ref)
bad_parameter()
`),
      {
        strictMacroSignatures: true,
        onError: (error) => parameterErrors.push(error.message),
      },
    );
    expect(parameterErrors[0]).toContain(
      "reference-only and cannot be used as a declaration name",
    );
  });

  test("rejects symbol references in handler parameters while allowing operation references", () => {
    const operationOnlyErrors: string[] = [];
    expandFunctionalMacros(
      parseBase(`\
macro referenced_operation()
  let operation = symbol_reference(read)
  let resume = identifier("resume")
  \`(fn generated(): GeneratedFx -> i32
    try
      GeneratedFx::$operation()
    GeneratedFx::$operation($resume):
      $resume(42))
referenced_operation()
`),
      {
        strictMacroSignatures: true,
        onError: (error) => operationOnlyErrors.push(error.message),
      },
    );
    expect(operationOnlyErrors).toEqual([]);

    const bareOperationOnlyErrors: string[] = [];
    expandFunctionalMacros(
      parseBase(`\
macro referenced_bare_operation()
  let operation = symbol_reference(read)
  let resume = identifier("resume")
  \`(fn generated(): GeneratedFx -> i32
    try
      GeneratedFx::$operation()
    $operation($resume):
      $resume(42))
referenced_bare_operation()
`),
      {
        strictMacroSignatures: true,
        onError: (error) => bareOperationOnlyErrors.push(error.message),
      },
    );
    expect(bareOperationOnlyErrors).toEqual([]);

    const parameterErrors: string[] = [];
    const parameterAst = parseBase(`\
macro referenced_parameter()
  let operation = symbol_reference(read)
  let resume = symbol_reference(existing_resume)
  \`(fn generated(): GeneratedFx -> i32
    try
      GeneratedFx::$operation()
    GeneratedFx::$operation($resume):
      $resume(42))
referenced_parameter()
`);
    expandFunctionalMacros(
      parameterAst,
      {
        strictMacroSignatures: true,
        onError: (error) => parameterErrors.push(error.message),
      },
    );
    expect(parameterErrors).toHaveLength(1);
    expect(parameterErrors[0]).toContain(
      "symbol_reference(existing_resume) is reference-only",
    );

    const bareParameterErrors: string[] = [];
    expandFunctionalMacros(
      parseBase(`\
macro referenced_bare_parameter()
  let operation = symbol_reference(read)
  let resume = symbol_reference(existing_resume)
  \`(fn generated(): GeneratedFx -> i32
    try
      GeneratedFx::$operation()
    $operation($resume):
      $resume(42))
referenced_bare_parameter()
`),
      {
        strictMacroSignatures: true,
        onError: (error) => bareParameterErrors.push(error.message),
      },
    );
    expect(bareParameterErrors).toHaveLength(1);
    expect(bareParameterErrors[0]).toContain(
      "symbol_reference(existing_resume) is reference-only",
    );
  });

  test("allows symbol references in type annotations and trait signatures", () => {
    const errors: string[] = [];
    expandFunctionalMacros(
      parseBase(`\
macro typed_local()
  let type_ref = symbol_reference(PrivateType)
  let local = identifier("local")
  \`(fn generated(value: $type_ref) -> $type_ref
    let $local: $type_ref = value
    $local)

macro typed_trait()
  let type_ref = symbol_reference(PrivateType)
  \`(trait Generated
    fn convert(value: $type_ref) -> $type_ref)

typed_local()
typed_trait()
`),
      {
        strictMacroSignatures: true,
        onError: (error) => errors.push(error.message),
      },
    );
    expect(errors).toEqual([]);
  });

  test("rejects symbol references in every macro and import binding slot", () => {
    const expansions = [
      "`(macro $ref() 1)",
      "`(pub macro $ref() 1)",
      "`(macro generated($ref) 1)",
      "`(attribute macro $ref(args, declaration) declaration)",
      "`(pub attribute macro generated($ref, declaration) declaration)",
      "`(macro_let $ref = 1)",
      "`(use src::tools::helper as $ref)",
      "`(pub use src::tools::helper as $ref)",
      "`(use src::tools::$ref)",
      "`(pub use src::tools::$ref)",
      "`(use src::tools::{ $ref })",
      "`(pub use src::tools::{ helper, $ref })",
    ];

    expansions.forEach((expansion) => {
      const errors: string[] = [];
      expandFunctionalMacros(
        parseBase(`\
macro reject_binding()
  let ref = symbol_reference(existing)
  ${expansion}
reject_binding()
`),
        {
          strictMacroSignatures: true,
          onError: (error) => errors.push(error.message),
        },
      );
      expect(errors, expansion).toHaveLength(1);
      expect(errors[0], expansion).toContain(
        "reference-only and cannot be used as a declaration name",
      );
    });
  });

  test("allows symbol references on the referenced side of an import", () => {
    const errors: string[] = [];
    expandFunctionalMacros(
      parseBase(`\
macro import_helper()
  let module_ref = symbol_reference(tools)
  let helper_ref = symbol_reference(helper)
  emit_many(
    \`(use $module_ref::helper as imported_helper),
    \`(use src::tools::$helper_ref as renamed_helper),
    \`(use src::tools::{ $helper_ref as grouped_helper })
  )
import_helper()
`),
      {
        strictMacroSignatures: true,
        onError: (error) => errors.push(error.message),
      },
    );
    expect(errors).toEqual([]);
  });

  test("rejects symbol references in tuple match binding slots", () => {
    const errors: string[] = [];
    expandFunctionalMacros(
      parseBase(`\
macro bad_match_binding()
  let ref = symbol_reference(bound)
  \`(match(value)
    ($ref, other): other)
bad_match_binding()
`),
      {
        strictMacroSignatures: true,
        onError: (error) => errors.push(error.message),
      },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(
      "reference-only and cannot be used as a declaration name",
    );
  });

  test("retains successful exports when later expansion fails", () => {
    const ast = parseBase(`\
pub macro keep(x)
  x
keep()
`);
    const errors: string[] = [];

    const { exports } = expandFunctionalMacros(ast, {
      strictMacroSignatures: true,
      onError: (error) => {
        errors.push(error.message);
      },
    });

    expect(errors).toHaveLength(1);
    expect(exports.map((entry) => entry.name.value)).toEqual(["keep"]);
  });

  test("does not throw for incomplete macro definitions while typing", () => {
    const code = `\
macro binaryen_gc_call
  syntax_template binaryen
`;
    expect(() => parse(code)).not.toThrow();
    expect(parse(code)).toBeInstanceOf(Form);
  });

  test("expands macro_let definitions into macro variables", () => {
    const ast = parse(functionalMacrosVoydFile);
    const plain = toPlain(ast);
    expect(
      containsDeep(plain, [
        "define-macro-variable",
        "extract_parameters",
        ["reserved-for-type"],
        ["is-mutable", "false"],
      ]),
    ).toBe(true);
  });

  test("expands nested macro invocations", () => {
    const code = `\
macro binaryen_gc_call(func, args)
  syntax_template binaryen func: $func namespace: gc args: $args
macro bin_type_to_heap_type(type)
    binaryen_gc_call(modBinaryenTypeToHeapType, BnrType<type>)
bin_type_to_heap_type(FixedArray<Int>)
`;
    const ast = parse(code);
    const plain = toPlain(ast);
    const binaryenCall = plain.find(
      (item) => Array.isArray(item) && item.at(0) === "binaryen",
    );
    expect(binaryenCall).toEqual([
      "binaryen",
      "modBinaryenTypeToHeapType",
      "gc",
      ["BnrType", ["generics", ["FixedArray", ["generics", "Int"]]]],
    ]);
  });

  test("double tilde preserves labeled args", () => {
    const code = `\
macro binaryen_gc_call_1(func, args)
  syntax_template binaryen func: $func namespace: gc args: $args
macro wrap()
  syntax_template $$(binaryen_gc_call_1(modBinaryenTypeToHeapType, syntax_template arg))
wrap()
`;
    const ast = parse(code);
    expect(
      containsDeep(toPlain(ast), [
        "binaryen",
        [":", "func", "modBinaryenTypeToHeapType"],
        [":", "namespace", "gc"],
        [":", "args", "arg"],
      ]),
    ).toBe(true);
  });

  test("calls recognizes internal identifier heads", () => {
    const code = `\
macro has_generics(type_expr)
  let maybe_generics = type_expr.get(1)
  if maybe_generics.calls(generics) then:
    1
  else:
    0
has_generics(Box<T>)
`;
    const ast = parse(code);
    const plain = toPlain(ast);
    expect(plain.at(-1)).toEqual("1");
  });

  test("with_location transfers source provenance to generated syntax", () => {
    const code = `\
macro relabel(generated, source)
  with_location(generated, source)
relabel(output, original)
`;
    const ast = parse(code);
    const output = ast.last;
    expect(output?.toJSON()).toBe("output");
    expect(output?.location?.startIndex).toBe(code.lastIndexOf("original"));
    expect(output?.location?.endIndex).toBe(
      code.lastIndexOf("original") + "original".length,
    );
    expect(output?.attributes).toBeUndefined();
  });

  test("with_location preserves source provenance through helper macros", () => {
    const code = `\
macro locate(generated, source)
  with_location(generated, source)
macro relabel(generated, source)
  locate(generated, source)
relabel(output, original)
`;
    const ast = parse(code);
    const output = ast.last;
    expect(output?.toJSON()).toBe("output");
    expect(output?.location?.startIndex).toBe(code.lastIndexOf("original"));
    expect(output?.location?.endIndex).toBe(
      code.lastIndexOf("original") + "original".length,
    );
    expect(output?.attributes).toBeUndefined();
  });

  test("supports clause-style if expressions in functional macros", () => {
    const code = `\
macro choose(n)
  if
    n == 1: 10
    n == 2: 20
    else: 30
choose(2)
`;
    const ast = parse(code);
    const plain = toPlain(ast);
    expect(plain.at(-1)).toEqual("20");
  });

  test("expands fn macro invocations", () => {
    const ast = parse(functionalMacrosVoydFile);
    const fibForm = toPlain(ast).at(-1);
    expect(fibForm).toEqual([
      "define_function",
      "fib",
      ["parameters", [":", "n", "i32"]],
      ["return_type", "i32"],
      [
        "block",
        [
          "block",
          ["define", "base", "1"],
          [
            "if",
            ["<=", "n", "base"],
            [":", "then", ["block", "n"]],
            [
              ":",
              "else",
              [
                "block",
                ["+", ["fib", ["-", "n", "1"]], ["fib", ["-", "n", "2"]]],
              ],
            ],
          ],
        ],
      ],
    ]);
  });

  test("splices top-level emit_many expansions into the ast root", () => {
    const code = `\
macro declare_pair()
  emit_many(\`(type (Left = i32)), \`(type (Right = i32)))
declare_pair()
`;
    const ast = parse(code);
    const plain = toPlain(ast);
    expect(plain).toContainEqual(["type", ["=", "Left", "i32"]]);
    expect(plain).toContainEqual(["type", ["=", "Right", "i32"]]);
  });

  test("treats empty emit_many lists as a no-op at top level", () => {
    const code = `\
macro emit_nothing()
  let declarations = \`().slice(1)
  emit_many(declarations)
emit_nothing()
type Keep = i32
`;
    const ast = parse(code);
    const plain = toPlain(ast);
    expect(plain).toContainEqual(["type", ["=", "Keep", "i32"]]);
    expect(plain).not.toContainEqual([]);
  });

  test("supports empty_list for explicit empty macro collections", () => {
    const code = `\
macro emit_nothing()
  let declarations = empty_list()
  emit_many(declarations)
emit_nothing()
type Keep = i32
`;
    const ast = parse(code);
    const plain = toPlain(ast);
    expect(plain).toContainEqual(["type", ["=", "Keep", "i32"]]);
    expect(plain).not.toContainEqual([]);
  });

  test("surfaces panic messages from functional macros", () => {
    const ast = parseBase(`\
macro fail()
  panic("boom")
fail()
`);
    const errors: string[] = [];

    expandFunctionalMacros(ast, {
      strictMacroSignatures: true,
      onError: (error) => {
        errors.push(error.message);
      },
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("boom");
  });

  test("does not implicitly splice top-level block expansions", () => {
    const code = `\
macro wrap_decl()
  \`(block (type (Only = i32)))
wrap_decl()
`;
    const ast = parse(code);
    expect(toPlain(ast)).toContainEqual([
      "block",
      ["type", ["=", "Only", "i32"]],
    ]);
  });

  test("supports pub-wrapped macro invocations", () => {
    const code = `\
macro declare_alias(name)
  \`(type ($name = i32))
pub declare_alias NumberLike
`;
    const ast = parse(code);
    const plain = toPlain(ast);
    expect(plain).toContainEqual(["pub", "type", ["=", "NumberLike", "i32"]]);
  });

  test("supports pub-wrapped value declarations from macros", () => {
    const code = `\
macro declare_value(name)
  \`(val $name { answer: i32 })
pub declare_value NumberLike
`;
    const ast = parse(code);
    const plain = toPlain(ast);
    expect(plain).toContainEqual([
      "pub",
      "val",
      "NumberLike",
      ["object_literal", [":", "answer", "i32"]],
    ]);
  });

  test("expands declaration attribute macros with structured arguments", () => {
    const code = `\
attribute macro companion(args, declaration)
  if args.length() == 1 then:
    emit_many(
      declaration,
      \`(fn generated() -> i32
        42)
    )
  else:
    panic("expected one attribute argument")

@companion(description: "generated helper")
fn original() -> i32
  1
`;

    const plain = toPlain(parse(code));
    expect(plain).toContainEqual([
      "fn",
      ["->", ["original"], "i32"],
      ["block", "1"],
    ]);
    expect(plain).toContainEqual([
      "fn",
      ["->", ["generated"], "i32"],
      ["block", "42"],
    ]);
  });

  test("applies stacked attribute macros from top to bottom", () => {
    const code = `\
attribute macro add_first(args, declaration)
  emit_many(
    declaration,
    \`(fn first_companion() -> i32
      1)
  )

attribute macro add_second(args, declaration)
  emit_many(
    declaration,
    \`(fn second_companion() -> i32
      2)
  )

@add_first
@add_second
fn original() -> i32
  0
`;

    const declarationNames = toPlain(parse(code)).flatMap((entry) =>
      Array.isArray(entry) && entry[0] === "fn"
        ? [((entry[1] as Plain)[1] as Plain)[0]]
        : [],
    );
    expect(declarationNames).toEqual([
      "original",
      "first_companion",
      "second_companion",
    ]);
  });

  test("bounds recursive attribute expansion", () => {
    const ast = parseBase(`\
attribute macro recurse(args, declaration)
  emit_many(\`(@ recurse), declaration)

@recurse
fn original() -> i32
  0
`);

    expect(() =>
      expandFunctionalMacros(ast, {
        strictMacroSignatures: true,
        maxAttributeExpansionDepth: 3,
      }),
    ).toThrow(/attribute macro expansion exceeded the depth limit of 3/i);
  });

  test("dispatches reserved compiler attributes after user expansion", () => {
    const ast = parse(`\
attribute macro preserve(args, declaration)
  declaration

@preserve
@effect(id: "voyd.example.time")
eff Time
  now
`);
    const effect = ast.rest.find(
      (entry) => entry instanceof Form && entry.calls("eff"),
    );

    expect(effect?.attributes?.effect).toEqual({ id: "voyd.example.time" });
  });

  test("rejects duplicate user-defined attributes", () => {
    expect(() =>
      parse(`\
attribute macro preserve(args, declaration)
  declaration

@preserve
@preserve
fn value() -> i32
  1
`),
    ).toThrow(/duplicate user-defined attribute '@preserve'/i);
  });

  test("rejects functional macros used as attributes", () => {
    expect(() =>
      parse(`\
macro ordinary(value)
  value

@ordinary
fn value() -> i32
  1
`),
    ).toThrow(/functional macro, not an attribute macro/i);
  });

  test("preserves unresolved attributes in context-free parser output", () => {
    const plain = toPlain(
      parse(`\
@imported_attribute
fn value() -> i32
  1
`),
    );

    expect(plain).toContainEqual(["@", "imported_attribute"]);
  });

  test("applies attribute macros to visibility-modified methods", () => {
    const plain = toPlain(
      parse(`\
attribute macro preserve(args, declaration)
  declaration

obj Box {}

impl Box
  @preserve
  api fn answer(self) -> i32
    42
`),
    );

    expect(
      containsDeep(plain, [
        "api",
        "fn",
        ["->", ["answer", "self"], "i32"],
        ["block", "42"],
      ]),
    ).toBe(true);
  });

  test("applies attribute macros to enum declarations", () => {
    const plain = toPlain(
      parse(`\
attribute macro preserve(args, declaration)
  declaration

@preserve
enum Status
  Ready
`),
    );

    expect(plain).toContainEqual(["enum", "Status", ["block", "Ready"]]);
  });

  test("expands attributes emitted by ordinary functional macros", () => {
    const plain = toPlain(
      parse(`\
attribute macro preserve(args, declaration)
  declaration

macro declare_attributed()
  emit_many(
    \`(@ preserve),
    \`(fn generated() -> i32
      42)
  )

declare_attributed()
`),
    );

    expect(plain).toContainEqual([
      "fn",
      ["->", ["generated"], "i32"],
      ["block", "42"],
    ]);
    expect(plain).not.toContainEqual(["@", "preserve"]);
  });
});
