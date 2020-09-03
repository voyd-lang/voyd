
struct Vec3 {
    var x: Float
    var y: Float
    var z: Float

    fn dot(vec: Vec3) =
        x * vec.x + y * vec.y + z * vec.z

    fn cross(vec: Vec3) = Vec3 [
        x: y * vec.z - z * vec.y,
        y: -(x * vec.z - z * vec.x),
        z: x * vec.y - y * vec.x
    ]

    prop sqrt = Vec3 [
        x: x.sqrt,
        y: y.sqrt,
        z: z.sqrt
    ]
}
