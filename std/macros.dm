// macro def(&body)
//	` define $(extract &body 0) $(extract &body 1)

// export def (parameters (&body))

// macro cond(&body)
//	quote if

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
			export $(extract body 1) $(extract body 2)

export pub (parameters (&body))

pub macro `(&body)
	quote quote $@&body

pub macro let(&body)
	define equals-expr (extract &body 0)
	` define
		$(extract equals-expr 1)
		$(extract equals-expr 2)

pub macro var(&body)
	define equals-expr (extract &body 0)
	` define-mut
		$(extract equals-expr 1)
		$(extract equals-expr 2)

pub macro lambda(&body)
	let parameters = &body.extract(0)
	let body = &body.extract(1)
	` lambda-expr $parameters $body

pub macro '=>'(&body)
	macro-expand
		` lambda $@&body

pub macro ';'(&body)
	let func = &body.extract(0)
	let block-list = &body.extract(1)
	if is-list(func)
		func.concat(block-list.slice(1))
		concat(`($func) block-list.slice(1))

pub macro fn(&body)
	let definitions = extract(&body 0)
	let identifier = extract(definitions 0)

	let params = #["parameters"].concat;
		definitions.slice(1).map (expr) =>
			let param-identifier-index = (if (expr.length == 3) 1 2)
			let param-identifier = extract(expr param-identifier-index)
			let type = extract(expr param-identifier-index + 1)
			` $param-identifier $type

	let type-arrow-index = if; (extract(&body 1) == "->")
		1
		if (extract(&body 2) == "->") 2 -1

	let return-type =
		` return-type
			$ if (type-arrow-index > -1)
				extract(&body type-arrow-index + 1)
				`()

	let expressions = if; (type-arrow-index > -1)
			&body.slice(type-arrow-index + 2)
			&body.slice(1)

	let extract-variables = (exprs) =>
		exprs.reduce(#[]) (vars expr) =>
			if (is-list(expr))
				if (extract(expr 0) == "define-mut" or extract(expr 0) == "define")
					block
						vars.push(#[extract(expr 1) extract(expr 2)])
						vars
					concat(vars extract-variables(expr))
				vars

	let variables = #[variables].concat(extract-variables(expressions))

	` define-function
		$identifier
		$params
		$variables
		$return-type
		// TODO: Debug why I can't use this syntax here
		// $ #["block"].concat(expressions)
		$(concat #["block"] expressions)

pub macro def-wasm-operator(op wasm-fn arg-type return-type)
	macro-expand
		` fn $op(left:$arg-type right:$arg-type) -> $return-type
			binaryen-mod ($arg-type $wasm-fn) (left right)

// extern $fn-id(namespace params*)
// extern max("Math" x:i32 y:i32)
pub macro extern-fn(&body)
	let definitions = &body.extract(0)
	let identifier = definitions.extract(0)
	let namespace = definitions.extract(1)
	let params = #["parameters"].concat;
		definitions.slice(2).map (expr) =>
			let param-identifier-index = (if (expr.length == 3) 1 2)
			let param-identifier = extract(expr param-identifier-index)
			let type = extract(expr param-identifier-index + 1)
			` $param-identifier $type

	let type-arrow-index = if; (extract(&body 1) == "->")
		1
		if (extract(&body 2) == "->") 2 -1

	let return-type = ` return-type
			$ if (type-arrow-index > -1)
				extract(&body type-arrow-index + 1)
				`()

	` define-extern-function
		$identifier
		$namespace
		$parameters
		$return-type

pub macro type(&body)
	define equals-expr (extract &body 0)
	` define
		$(extract equals-expr 1)
		$(extract equals-expr 2)
