macro `(&body)
	quote quote $@&body

macro let(&body)
	define equals-expr (extract &body 0)
	` define
		$(macro-expand (extract equals-expr 1))
		$(macro-expand (extract equals-expr 2)))

macro var(&body)
	define equals-expr (extract &body 0)
	`(define-mut $(extract equals-expr 1) $(extract equals-expr 2))

macro lambda(&body)
	` lambda-expr $@(macro-expand &body)

macro '=>'(&body)
	let quoted = `(lambda $@(&body))
	macro-expand quoted


macro ';'(&body)
	let func = macro-expand(&body.extract(0))
	let block-list = macro-expand(&body.extract(1))
	if is-list(func)
		func.concat(block-list.slice(1))
		concat(`($func) block-list.slice(1))

macro fn(&body)
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
		$ #["block"].concat(expressions)


macro pub(&body)
	let expanded = macro-expand(&body)
	` splice-block
			$expanded
			export $(extract expanded 1) $(extract expanded 2)

macro def-wasm-operator(op wasm-fn arg-type return-type)
	let expanded = macro-expand;
		` pub fn $op(left:$arg-type right:$arg-type) -> $return-type
			binaryen-mod ($arg-type $wasm-fn) (left right)

def-wasm-operator('<' lt_s i32 i32)
def-wasm-operator('+' add i32 i32)
def-wasm-operator('<' lt f32 i32)
def-wasm-operator('-' sub f32 f32)
def-wasm-operator('+' add f32 f32)
