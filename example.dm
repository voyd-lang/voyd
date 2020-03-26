

struct Target [
    x: Number, y: Number, z: Number

    def offs [x: Number] -> Target {
        Target [x: self.x + x, y, z]
    }

    mut def shift [y: Number] -> Void {
        self.y += y
    }
]

let target = Target [x: 5, y: 3, z: 2]

def move([x: Number, y: Number]) -> [x: Number, y: Number] {
    // ...
}

move [x: 5, y: 3]
