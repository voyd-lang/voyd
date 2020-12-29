import {
    Assignment, BinaryExpression, Block, Call, ContainerNode, FunctionNode, Identifier, If,
    Impl, IntLiteral, Module, NamedNode, Node, PropertyAccess, StructLiteral, TypedNode, TypeNode, Use,
    UseTree, Variable, While
} from "./ast";


/** Enforces scoping rules, resolves identifiers and infers types. */
export function analyseSemantics(container: ContainerNode): void {
    if (container.hasBeenSemanticallyAnalyzed) return;
    for (const instruction of container.children) {
        scanInstruction(instruction, container)
    }
    container.hasBeenSemanticallyAnalyzed = true;
}

function scanInstruction(instruction: Node, container: ContainerNode) {
    if (instruction instanceof Block) {
        scanBlock(instruction);
        return;
    }

    if (instruction instanceof Module) {
        analyseSemantics(instruction);
        if (instruction.name === "mod") container.import(instruction.exports);
        return;
    }

    if (instruction instanceof Use) {
        scanUseTree(instruction.tree, container);
        return;
    }

    if (instruction instanceof Impl) {
        scanImpl(instruction, container);
        return;
    }

    if (instruction instanceof Variable) {
        scanVariableDeclaration(instruction, container);
        return;
    }

    if (instruction instanceof FunctionNode) {
        scanFn(instruction, container);
        return;
    }

    if (instruction instanceof If) {
        scanIf(instruction, container);
        return;
    }

    if (instruction instanceof While) {
        scanBlock(instruction.block);
        scanInstruction(instruction.condition, container);
        return;
    }

    if (instruction instanceof Identifier) {
        const entity = container.lookupSymbol(instruction.name);
        if (!entity) throw new Error(`No entity with label ${instruction.name} in current scope.`);
        if (entity instanceof Variable && instruction.tokenIndex < entity.tokenIndex) {
            throw new Error(`Identifier ${instruction.name} used before defined`);
        }
        instruction.resolve(entity as NamedNode);
    }

    if (instruction instanceof BinaryExpression) {
        instruction.arguments.forEach(instruction => scanInstruction(instruction, container));
        const typeEntity = typeEntityOfExpression(instruction.arguments[0], container);
        if (!typeEntity) throw new Error("Missing type for left hand of binary expression");
        const func = typeEntity.lookupSymbol(instruction.calleeName);
        if (!func || !(func instanceof FunctionNode)) throw new Error(`${instruction.calleeName} is not a function`);
        instruction.resolveCallee(func);
        return;
    }

    if (instruction instanceof Call) {
        instruction.arguments.forEach(instruction => scanInstruction(instruction, container));
        const func = container.lookupSymbol(instruction.calleeName);
        if (!func || !(func instanceof FunctionNode)) throw new Error(`${instruction.calleeName} is not a function`);
        instruction.resolveCallee(func);
        return;
    }

    if (instruction instanceof PropertyAccess) {
        scanPropertyAccessExpression(instruction, container);
        return;
    }

    if (instruction instanceof Assignment) {
        scanAssignment(instruction, container);
        return;
    }

    if (instruction instanceof StructLiteral) {
        scanStructLiteral(instruction, container);
        return;
    }
}

function scanUseTree(tree: UseTree, container: ContainerNode) {
    const resolveUseModule = (module: ContainerNode, path: Identifier[]): ContainerNode => {
        if (path.length === 0) return module;
        const moduleIdentifier = path.shift()!;
        const subMod = module.lookupSiblingModule(moduleIdentifier.name);
        if (!subMod) throw new Error(`Module ${moduleIdentifier.name} not found.`);
        return resolveUseModule(subMod, path);
    }
    const useModule = resolveUseModule(container, JSON.parse(JSON.stringify(tree.path)));
    analyseSemantics(useModule);

    if (tree.node.kind === "self") {
        // TODO
    }

    if (tree.node.kind === "alias") {
        // TODO
    }

    if (tree.node.kind === "wildcard") {
        container.import(useModule.exports);
    }

    if (tree.node.kind === "branched") {
        for (const branch of tree.node.branches) {
            scanUseTree(branch, useModule);
        }
    }
}

function scanBlock(block: Block) {
    for (const instruction of block.children) {
        scanInstruction(instruction, block);
    }
}


function scanStructLiteral(struct: StructLiteral, container: ContainerNode) {
    for (const label in struct.fields) {
        const fieldNode = struct.fields[label];
        scanInstruction(fieldNode.initializer, container);
        fieldNode.resolveType(typeEntityOfExpression(fieldNode.initializer, container));
    }
}

function scanAssignment(expr: Assignment, container: ContainerNode) {
    scanInstruction(expr.assignee, container);
    scanInstruction(expr.expression, container);

    if (expr.assignee instanceof Identifier) {
        const entity = expr.assignee.ref();
        if (!entity.flags.includes("let")) return;
        throw new Error(`Error: Cannot reassign immutable variable: ${expr.assignee.name}.`);
    }
}

function scanPropertyAccessExpression(expr: PropertyAccess, container: ContainerNode) {
    const left = expr.left;
    const right = expr.right;
    scanInstruction(left, container);
    const typeEntity = typeEntityOfExpression(left, container);

    if (right instanceof Call) {
        const typeEntityFunc = typeEntity.lookupTypeSymbol(right.calleeName);

        if (typeEntityFunc instanceof FunctionNode) {
            right.resolveCallee(typeEntityFunc)
            return;
        }

        // UFCS Search
        const scopeEntityFunc = container.lookupSymbol(right.calleeName)
        if (!scopeEntityFunc || !(scopeEntityFunc instanceof FunctionNode)) {
            throw new Error(`${right.calleeName} is not a function`);
        }
        right.resolveCallee(scopeEntityFunc);
        return;
    }

    if (right instanceof Identifier) {
        scanInstruction(right, typeEntity);
        return;
    }

    throw new Error(`Invalid right of property access expression.`);
}


function scanVariableDeclaration(expr: Variable, container: ContainerNode) {
    if (expr.initializer) scanInstruction(expr.initializer, container);
    if (expr.typeName) {
        const typeEntity = container.lookupTypeSymbol(expr.typeName);
        if (!typeEntity) throw new Error(`Could not resolve type for ${expr.name}`);
        expr.resolveType(typeEntity);
    } else if (expr.initializer) {
        const typeEntity = typeEntityOfExpression(expr.initializer, container);
        expr.resolveType(typeEntity);
    } else {
        throw new Error(`Could not resolve type for ${expr.name}`);
    }
}

function scanImpl(instruction: Impl, container: ContainerNode) {
    const target = container.lookupSymbol(instruction.targetName);
    if (!target) throw new Error(`Target ${instruction.targetName} for impl not found`);
    if (!(target instanceof TypeNode)) throw new Error(`Cannot impl ${instruction.targetName}, not a type.`);
    instruction.functions.forEach(fn => {
        scanFn(fn, instruction);
        target.pushChild(fn);
    });
}

function scanFn(fn: FunctionNode, container: ContainerNode) {
    if (fn.returnTypeName && fn.name === "fib") {
        const typeEntity = container.lookupTypeSymbol(fn.returnTypeName);
        if (!typeEntity) throw new Error(`No type with name ${fn.returnTypeName} found.`)
        fn.resolveReturnType(typeEntity)
    }

    if (fn.returnTypeName) {
        const typeEntity = container.lookupTypeSymbol(fn.returnTypeName);
        if (!typeEntity) throw new Error(`No type with name ${fn.returnTypeName} found.`)
        fn.resolveReturnType(typeEntity)
    }

    fn.parameters.forEach(p => {
        if (p.typeName) {
            const typeEntity = container.lookupTypeSymbol(p.typeName);
            if (!typeEntity) throw new Error(`Cannot resolve type for ${p.name} of ${fn.name}.`);
            p.resolveType(typeEntity)
            return;
        }

        if (p.initializer) {
            const typeEntity = typeEntityOfExpression(p.initializer, container);
            p.resolveType(typeEntity)
            return;
        }

        throw new Error(`Cannot resolve type for ${p.name} of ${fn.name}.`);
    });

    if (fn.expression) scanInstruction(fn.expression, fn);

    if (!fn.resolvedReturnType && fn.expression) {
        const typeEntity = typeEntityOfExpression(fn.expression, fn);
        fn.resolveReturnType(typeEntity)
    } else if (!fn.resolvedReturnType && !fn.expression) {
        throw new Error(`Missing return type for ${fn.name}`);
    }
}

function scanIf(ifNode: If, container: ContainerNode) {
    scanInstruction(ifNode.condition, container);
    scanBlock(ifNode.block);
    ifNode.elifs.forEach(({ condition, block }) => {
        scanInstruction(condition, container);
        scanBlock(block);
    });
    if (ifNode.elseBlock) scanBlock(ifNode.elseBlock);
}

function typeEntityOfExpression(expr: Node, container: ContainerNode): TypeNode {
    if (expr instanceof Identifier) {
        const entity = expr.ref();
        if (entity instanceof TypeNode) return entity;
        if (entity instanceof TypedNode) return entity.type;
    }

    if (expr instanceof StructLiteral) {
        return expr;
    }

    if (expr instanceof Block) {
        const lastChild = expr.lastChild();
        if (!lastChild) return container.lookupTypeSymbol("Void")!;
        return typeEntityOfExpression(lastChild, expr);
    }

    if (expr instanceof Call || expr instanceof BinaryExpression) {
        if (!expr.resolvedCallee) throw new Error(`Function not yet resolved for ${expr.calleeName}`);
        return expr.resolvedCallee.returnType;
    }

    if (expr instanceof If) {
        return typeEntityOfExpression(expr.block, expr.block);
    }

    if (expr instanceof IntLiteral) {
        const i32Entity = container.lookupTypeSymbol("i32");
        if (!i32Entity) throw new Error("Uh oh. i32 entity not found. Bad compiler! BAD!");
        return i32Entity;
    }

    if (expr instanceof PropertyAccess) {
        return typeEntityOfExpression(expr.right, container);
    }

    throw new Error(`Cannot determine type entity for ${expr}`);
}
