let return-type = quote;
	return-type
	$ if (type-arrow-index > -1)
		extract(&body type-arrow-index + 1)
		`()

macro def-wasm-operator(op wasm-fn arg-type return-type)
	let expanded = macro-expand;
		` pub fn $op(left:$arg-type right:$arg-type) -> $return-type
			binaryen-mod ($arg-type $wasm-fn) (left right)

macro def-wasm-operator(op wasm-fn arg-type return-type)
	let expanded = macro-expand
		` pub fn $op(left:$arg-type right:$arg-type) -> $return-type
			binaryen-mod ($arg-type $wasm-fn) (left right)
