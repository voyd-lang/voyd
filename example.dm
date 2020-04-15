
struct Vec3 |T: Numeric| [
    pub x, y, z: T

    pub def cross [with otherVec: Vec3|T|] -> Vec3|T| {
        Vec3 [
            x: y * otherVec.z - z * otherVec.z * otherVec.y,
            y: -(x * otherVec.z - z * otherVec.x),
            z: x * otherVec.y - y * otherVec.x
        ]
    }
]

def generateRandomVec3s(count = 10) -> Array|Vec3<Int>| {
    Array [size: count]
        .fillEach { Vec3 [x: rand(), y: rand(), z: rand()] }
}

let crossedVec = generateRandomVec3s()
    .reduce { $0.cross($1) }

html! {
    div! {
        p! { "Hello" }
        p! { "How are you today" }
    }

    ul! {
        messages.map { m | m.inCaps() }
    }
}
