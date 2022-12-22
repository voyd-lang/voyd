macro pub(&body)
	// Temp hack to get pub def-wasm-operator and the like to work
	define body
		if is-list(&body.extract(0))
			&body.extract(0)
			&body

	define expanded macro-expand(body)

	if expanded.extract(0) == "macro"
		block
			register-macro expanded.slice(1)
			define definitions expanded.extract(1)
			quote splice-block
				export
					$(extract definitions 0)
					(parameters $(slice definitions 1))
		quote splice-block
			$expanded
			export $(extract expanded 1) $(extract expanded 2)

export pub (parameters (&body))

pub macro `(&body)
	quote quote $@&body

pub macro ':'(&body)
	define expr0 &body.extract(0)
	define expr1 &body.extract(1)
	` labeled-expr $expr0 $expr1

pub macro let(&body)
	define equals-expr (extract &body 0)
	macro-expand
		` define
			$(extract equals-expr 1)
			$(extract equals-expr 2)

pub macro var(&body)
	define equals-expr (extract &body 0)
	macro-expand
		` define-mut
			$(extract equals-expr 1)
			$(extract equals-expr 2)

pub macro ';'(&body)
	let func = &body.extract(0)
	let body = &body.extract(1)
	let args = if body.extract(0) == "block"
		body.slice(1)
		body
	if is-list(func)
		func.concat(args)
		concat(`($func) args)

pub macro lambda(&body)
	let parameters = &body.extract(0)
	let body = &body.extract(1)
	` lambda-expr $parameters $body

pub macro '=>'(&body)
	macro-expand;
		` lambda $@&body

// Extracts typed parameters from a list where index 0 is fn name, and offset-index+ are typed parameters
let extract-parameters = (definitions) =>
	`(parameters).concat
		definitions.slice(1).map (expr) =>
			let param-identifier-index = (if (expr.length == 3) 1 2)
			let param-identifier = extract(expr param-identifier-index)
			let type = extract(expr param-identifier-index + 1)
			` $param-identifier $type

pub macro fn(&body)
	let definitions = extract(&body 0)
	let identifier = extract(definitions 0)
	let params = extract-parameters(definitions)

	let type-arrow-index = if (extract(&body 1) == "->")
		1
		if (extract(&body 2) == "->") 2 -1

	let return-type =
		` return-type
			$ if (type-arrow-index > -1)
				extract(&body type-arrow-index + 1)
				`()

	let expressions = macro-expand
		if (type-arrow-index > -1)
			&body.slice(type-arrow-index + 2)
			&body.slice(1)

	let extract-variables = (exprs) =>
		exprs.reduce(`()) (vars expr) =>
			if (is-list(expr))
				if (extract(expr 0) == "define-mut" or extract(expr 0) == "define")
					block
						// For now, assume all vars are typed
						let definition = extract(expr 1)
						vars.push(#[extract(definition 1) extract(definition 2)])
						vars.concat(expr.extract(2).extract-variables())
					concat(vars extract-variables(expr))
				vars

	let variables = `(variables).concat(extract-variables(expressions))

	` define-function
		$identifier
		$params
		$variables
		$return-type
		// TODO: Debug why I can't use this syntax here (its because I need to change the interpolation syntax, right now it just an s-expression style function call)
		// $ #["block"].concat(expressions)
		$(concat #["block"] expressions)

pub macro def-wasm-operator(op wasm-fn arg-type return-type)
	macro-expand
		` fn $op(left:$arg-type right:$arg-type) -> $return-type
			binaryen-mod ($arg-type $wasm-fn) (left right)

// extern $fn-id(namespace params*)
// extern max("Math" x:i32 y:i32)
pub macro extern-fn(&body)
	let namespace = &body.extract(0)
	let definitions = &body.extract(1)
	let identifier = definitions.extract(0)
	let parameters = extract-parameters(definitions)

	let type-arrow-index = if (extract(&body 1) == "->")
		1
		if (extract(&body 2) == "->") 2 -1

	let return-type =
		` return-type
			$ if (type-arrow-index > -1)
				extract(&body type-arrow-index + 1)
				`()

	` define-extern-function
		$identifier
		namespace $namespace
		$parameters
		$return-type

pub macro match(&body)
	let value-expr = &body.extract(0)
	let cases = &body.slice(1)
	let expand-cases = (cases index) =>
		let case = cases.extract(index)
		if is-list(case) and (case.length == 1)
			case.extract(0) // Default
			if is-list(case)
				` if $(extract case 0) == match-value
					$(extract case 1)
					$(&lambda cases (index + 1))

	let conditions = expand-cases(cases 0)
	` block
		let match-value = $value-expr
		$conditions

pub macro type(&body)
	define equals-expr (extract &body 0)
	let expr = equals-expr.extract(2)
	if expr.is-list and (expr.extract(0) == "struct")
		struct-to-cdt(equals-expr.extract(1) expr)
		` define-type
			$(extract equals-expr 1)
			$(extract (extract equals-expr 2) 1)

var cdt-type-id = 0

// Takes (struct $typed-parameter*), returns (define-cdt $name $type-id:i32 $size:i32) + field accessor functions
let struct-to-cdt = (name expr) =>
	let fields = expr.slice(1)
	cdt-type-id = cdt-type-id + 1
	let get-size = (param) => param.extract(2).match
		"i32" 4
		"i64" 8
		"f32" 4
		"f64" 8
		4
	let total-size = fields.reduce(0) (size param) =>
		let next-size = param.get-size
		next-size + size

	var cur-size = 0
	let accessors = fields.reduce(`()) (accessors param) =>
		let field-name = param.extract(1)
		let field-type = param.extract(2)
		let offset = cur-size
		cur-size = offset + param.get-size
		let read-fn = field-type.match
			"i32" `(read-i32)
			"i64" `(read-i64)
			"f32" `(read-f32)
			"f64" `(read-f64)
			`(read-i32) // TODO Support sub-structs

		let read-accessor =
			` fn $field-name(self:$name) -> $field-type
				$@read-fn self $offset

		let write-name = "set-" + field-name
		let write-fn = field-type.match
			"i32" `(store-i32)
			"i64" `(store-i64)
			"f32" `(store-f32)
			"f64" `(store-f64)
			`(store-i32) // TODO Support sub-structs

		let write-accessor =
			` fn $write-name(self:$name value:$field-type) -> void
				$@write-fn self $offset value

		accessors.push(read-accessor)
		accessors.push(write-accessor)
		accessors

	` splice-block
		define-cdt $name $cdt-type-id $total-size
		$@accessors

pub macro global(&body)
	let mutability = extract &body 0
	let equals-expr = extract &body 1
	let function = if mutability == "let"
		` define-global
		` define-mut-global
	`	$@function
		$(extract equals-expr 1)
		$(extract (extract equals-expr 2) 1)
