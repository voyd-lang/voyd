
def fib(n: i32) -> i32 {
    if n < 2 { return n }
    return fib(n - 2) + fib(n - 1)
}

let count = 10
print(fib(count))
