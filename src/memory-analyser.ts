import { Call, ContainerNode, FunctionNode, Struct, Variable } from "./ast";

export function analyseMemory(container: ContainerNode) {
    for (const instruction of container.children) {
        if (instruction instanceof FunctionNode) {
            scanFn(instruction, container);
        }
    }
}

function scanFn(fn: FunctionNode, container: ContainerNode) {
    if (!(fn.returnType instanceof Struct)) {
        fn.addStackReturnParameter();
    }

    for (const instruction of container.children) {
        if (instruction instanceof Call) {

        }
    }
}

function scanCall(call: Call, container: ContainerNode, stackVar?: Variable) {
    const fn = call.callee;
    if (!(fn.returnType instanceof Struct)) return;
    const realStackVar = stackVar ? stackVar : container.addStackReturnVariable();
    call.arguments.push(realStackVar)
}
