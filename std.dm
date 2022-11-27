macro def-wasm-operator(op wasm-fn arg-type return-type)
	pub fn $op(left:$arg-type right:$arg-type) -> $return-type
		binaryen-mod ($arg-type $wasm-fn) (left right)

macro pub(&body)
	$&body
	export $(extract &body 1)

macro let(&body)
	define $(extract &body 0) $(extract &body 2)

macro var(&body)
	define-mut $(extract &body 0) $(extract &body 2)

; TODO: the same, but for ifs
macro lambda(&body)
	lambda-expr (quote $&body)

macro fn(&body)
	$ block
		let definitions = extract(&body 0)
		let identifier = extract(definitions 0)

		let params = concat
			#["parameters"]
			definitions.slice(1).map lambda (expr)
				let param-identifier-index = (if (expr.length == 3) 1 2)
				let param-identifier = extract(expr param-identifier-index)
				let type = extract(expr param-identifier-index + 1)
				#[param-identifier type]

		let type-arrow-index = if (extract(&body 1) == "->")
			1
			if (extract(&body 2) == "->") 2 -1)

		let return-type = #[
			"return-type"
			if (type-arrow-index > -1)
				extract(&body type-arrowIndex + 1)
				#[]
		]

		let expressions = if (typeArrowIndex > -1)
			&body.slice(type-arrow-index + 2)
			&body.slice(1)

		let variables = expressions.reduce(#[]) lambda (vars expr)
			if (is-list(vars))
				if (extract(vars 0) == "define-let")
					vars.push(#[extract(expr 1) extract(expr 2)])
					concat(vars &lambda(expr))
			vars


		#[
			"define-function",
			identifier,
			params,
			variables,
			return-type
			concat(["block", expressions])
		]


def-wasm-operator('<' lt_s i32 i32)
def-wasm-operator('-' sub i32 i32)
def-wasm-operator('+' add i32 i32)

def-wasm-operator('<' lt f32 i32)
def-wasm-operator('-' sub f32 f32)
def-wasm-operator('+' add f32 f32)
