
export interface MemType {
    name: string;
    size: number;
    offset: number;
}

export interface MemInt32 extends MemType {
    name: "i32";
    size: 32;
}

export interface MemFloat32 extends MemType {
    name: "f32";
    size: 32;
}

export interface MemStruct extends MemType {
    name: "struct";
    fields: { [identifier: string]: MemType };
}

export interface MemTuple extends MemType {
    name: "tuple";
    fields: MemType[];
}

export interface MemPointer extends MemType {
    name: "pointer";
    /** Made up of two i32s; A size and offset. */
    size: 64;
}

export interface MemTable extends MemType {

}
