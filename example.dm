
fn fib(n: i32) =
    if n < 2 {
        n
    } else {
        fib(n - 2) + fib(n - 1)
    }

let count = 10
print(fib(count))
