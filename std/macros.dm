macro pub(&body)
	// Temp hack to get pub def-wasm-operator and the like to work
	define body
		if is-list(&body.extract(0))
			&body.extract(0)
			&body

	define expanded macro-expand(body)

	log expanded

	if expanded.extract(0) == "macro"
		block
			register-macro expanded
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

pub macro let(&body)
	define equals-expr (extract &body 0)
	` define
		$(macro-expand (extract equals-expr 1))
		$(macro-expand (extract equals-expr 2)))

pub macro var(&body)
	define equals-expr (extract &body 0)
	` define-mut
		$(macro-expand (extract equals-expr 1))
		$(macro-expand (extract equals-expr 2)))

pub macro lambda(&body)
	` lambda-expr $@(macro-expand &body)

pub macro '=>'(&body)
	let quoted = `(lambda $@(&body))
	macro-expand quoted

pub macro ';'(&body)
	let func = macro-expand(&body.extract(0))
	let block-list = macro-expand(&body.extract(1))
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

	let return-type = quote;
		return-type
		$ if (type-arrow-index > -1)
			extract(&body type-arrow-index + 1)
			`()

	let expressions = macro-expand;
		if (type-arrow-index > -1)
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
	let expanded = macro-expand;
		` fn $op(left:$arg-type right:$arg-type) -> $return-type
			binaryen-mod ($arg-type $wasm-fn) (left right)
