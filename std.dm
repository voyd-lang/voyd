macro def-wasm-operator(op wasm-fn arg-type return-type)
	pub fn $op(left:$arg-type right:$arg-type) -> $return-type
		binaryen-mod ($arg-type $wasm-fn) (left right)

macro pub(&body)
	$&body
	export $(extract &body 1)

macro let(&body)
	$@ block
		define equals-expr (extract &body 0)
		#[
			"define"
			extract equals-expr 1
			extract equals-expr 2
		]

macro var(&body)
	$@ block
		define equals-expr (extract &body 0)
		#[
			"define-mut"
			extract equals-expr 1
			extract equals-expr 2
		]

macro lambda(&body)
	lambda-expr (quote $&body)

macro '=>'(&body)
	lambda-expr (quote $(macro-expand &body))

macro '<|'(&body)
	$@ block
		&body

macro fn(&body)
	$@ block
		let definitions = extract(&body 0)
		let identifier = extract(definitions 0)

		let params = #["parameters"].concat(
			definitions.slice(1).map (expr) =>
				let param-identifier-index = (if (expr.length == 3) 1 2)
				let param-identifier = extract(expr param-identifier-index)
				let type = extract(expr param-identifier-index + 1)
				#[param-identifier type]
		)

		let type-arrow-index = (if (extract(&body 1) == "->")
			1
			if (extract(&body 2) == "->") 2 -1)


		let return-type = #[
			"return-type"
			if (type-arrow-index > -1)
				extract(&body type-arrow-index + 1)
				#[]
		]

		let expressions = macro-expand <|
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

		#[
			"define-function"
			identifier
			params
			variables
			return-type
			#["block"].concat(expressions)
		]


def-wasm-operator('<' lt_s i32 i32)
; def-wasm-operator('-' sub i32 i32)
; def-wasm-operator('+' add i32 i32)
;
; def-wasm-operator('<' lt f32 i32)
; def-wasm-operator('-' sub f32 f32)
; def-wasm-operator('+' add f32 f32)
