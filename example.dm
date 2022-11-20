
fn fib(n:Int) -> Int
	if (n < 2)
		n
		fib(n - 1) + fib(n - 2)

fn call-method(label:n:Float) -> Float
	add.a.ridiculous(n 1.7)

fn with-generics-a`(T)(label) -> Array`(Int)

fn with-generics-b[T](label) -> [T T T]
fn with-generics-b[T](label) -> Hello[T T T]

fn multi-line-block() -> Hello
	world()
	how-are-we()

fn with-effects() (Async Console) -> Int
	3

fn effect-with-args() Async<Int>
