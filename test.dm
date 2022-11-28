let hello = world

let goose =
	(egg)

let type-arrow-index = (if (extract(&body 1) == "->") 1 (if (extract(&body 2) == "->") 2 -1)))

() => a
() =>
	a
() => a()
() => (a)

let x = (a) => hello()

let extract-variables = (exprs) =>
	exprs.reduce(#[]) (vars expr) =>
		if (is-list(vars))
			if (extract(vars 0) == "define-mut" or extract(vars 0) == "define")
				vars.push(#[extract(expr 1) extract(expr 2)])
				concat(vars extract-variables(expr))
		vars
	hello

let extract-variables = (exprs) =>
	exprs.reduce(#[]) (vars expr) =>
		if (is-list(vars))
			if (extract(vars 0) == "define-mut" or extract(vars 0) == "define")
				vars.push(#[extract(expr 1) extract(expr 2)])
				concat(vars extract-variables(expr))
		vars
