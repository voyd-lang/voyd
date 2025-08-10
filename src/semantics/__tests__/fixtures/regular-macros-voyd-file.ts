export const regularMacrosVoydFile = `
macro \`()
  quote quote $@body

macro let()
  define equals_expr body.extract(0)
  \` define $(equals_expr.extract(1)) $(equals_expr.extract(2))

// Extracts typed parameters from a list where index 0 is fn name, and offset_index+ are labeled_expr
macro_let extract_parameters = (definitions) =>
  \`(parameters).concat definitions.slice(1)

macro fn()
  let first = body.extract(0)
  let is_equals = first.extract(0) == "="
  let definitions =
    if is_equals then:
      first.extract(1)
    else:
      first
  let identifier_list =
    if definitions.extract(0) == ":" then:
      definitions.extract(1)
    else:
      if definitions.extract(0) == "->" then:
        definitions.extract(1)
      else:
        definitions
  let return_type =
    if definitions.extract(0) == ":" then:
      definitions.slice(2, 3)
    else:
      if definitions.extract(0) == "->" then:
        definitions.slice(2, 3)
      else: \`()
  let identifier = identifier_list.extract(0)
  let params = extract_parameters(identifier_list)
  let expressions =
    if is_equals then:
      first.slice(2)
    else:
      body.slice(1)
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
