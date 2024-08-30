import { CharStream } from "../../parser/char-stream.js";

export const regularMacrosVoidFile = `
macro \`()
  quote quote $@body

macro let()
  define equals_expr body.extract(0)
  \` define $(equals_expr.extract(1)) $(equals_expr.extract(2))

// Extracts typed parameters from a list where index 0 is fn name, and offset_index+ are labeled_expr
macro_let extract_parameters = (definitions) =>
  \`(parameters).concat definitions.slice(1)

macro fn()
  let definitions = body.extract(0)
  let identifier = definitions.extract(0)
  let params = extract_parameters(definitions)

  let type_arrow_index =
    if body.extract(1) == "->" then:
      1
    else:
      if body.extract(2) == "->" then: 2 else: -1

  let return_type =
    if type_arrow_index > -1 then:
      body.slice(type_arrow_index + 1, type_arrow_index + 2)
    else: \`()

  let expressions =
    if type_arrow_index > -1 then:
      body.slice(type_arrow_index + 2)
    else: body.slice(1)

  \`(define_function,
    $identifier,
    $params,
    (return_type $@return_type),
    $(\`(block).concat(expressions)))

fn fib(n: i32) -> i32
  let base = 1
  if n <= base then:
    n
  else:
    fib(n - 1) + fib(n - 2)
`;
