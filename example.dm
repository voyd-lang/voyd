
def fib(n: i32) -> i32 {
    if n < 2 { return n }
    return fib(n - 2) + fib(n - 1)
}

let count = 10
print(fib(count))

robot
    .moveL [x: 5, y: 3, z: 2]
    .moveL [x: 5, y: 1, z: 1]
    .moveL [x: 5, y: 4, z: 3]

render [scene: scene1, world: earth, samples: 23]

select(item, [delay: 3000])
