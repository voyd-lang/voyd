
fn fib(n:Int) -> Int
	if (n < 2)
		n
		fib(n - 1) + fib(n - 2)
