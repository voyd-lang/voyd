/* eslint-disable @typescript-eslint/ban-types */
import uniqid from "uniqid";

export class Node {
    readonly id = uniqid();
    parent?: Node;

    constructor(parent?: Node) {
        this.parent = parent;
    }

    toJSON(): object {
        return { node: this.constructor.name };
    }
}

export abstract class StatementNode extends Node { }

export abstract class ExpressionNode extends StatementNode { }

export class NamedNode extends StatementNode {
    readonly name: string;
    readonly flags: string[];

    constructor(opts: {
        name: string,
        flags: string[],
        parent?: ContainerNode
    }) {
        super(opts.parent);
        this.name = opts.name;
        this.flags = opts.flags;
    }

    toJSON(): object {
        return { ...super.toJSON(), name: this.name }
    }
}

export abstract class ContainerNode extends StatementNode {
    protected readonly symbols: Map<string, NamedNode>;
    protected readonly ownSymbols: Set<string> = new Set();
    readonly flags: string[];
    readonly children: Node[] = [];
    parent?: ContainerNode;

    constructor(opts: {
        flags: string[],
        parent?: ContainerNode,
    }) {
        super(opts.parent);
        this.flags = opts.flags;
        this.parent = opts.parent;
        this.symbols = opts.parent ? opts.parent.symbols : new Map();
    }

    toJSON(): object {
        return { ...super.toJSON(), flags: this.flags, children: this.children };
    }

    import(nodes: Set<string>): void {
        nodes.forEach(v => this.ownSymbols.add(v));
    }

    get exports(): Set<string> {
        return new Set(this.ownSymbols);
    }

    get namesOfExports(): string[] {
        const names: string[] = [];
        for (const id of this.ownSymbols) {
            const symbol = this.getSymbol(id);
            if (!symbol) continue;
            names.push(symbol.name);
        }
        return names;
    }

    pushChild(...children: Node[]): void {
        this.children.push(...children);
        for (const child of children) {
            if (
                child instanceof NamedNode ||
                child instanceof TypeNode ||
                child instanceof Module
            ) {
                this.insertSymbol(child)
            }
        }
    }

    insertSymbol(node: NamedNode): void {
        this.symbols.set(node.id, node);
        this.ownSymbols.add(node.id);
        if (node instanceof Variable) {
            this.registerVariableWithParentFn(node);
        }
    }

    private registerVariableWithParentFn(variable: Variable): void {
        if (this instanceof FunctionNode) {
            this.variables.push(variable);
            return;
        }

        if (this.parent) {
            this.parent.registerVariableWithParentFn(variable);
            return;
        }

        throw new Error("Variable declared outside of function scope.");
    }

    lookupSymbol(name: string): Node | undefined {
        for (const nodeId of this.ownSymbols) {
            const node = this.symbols.get(nodeId);
            if (node && node.name === name) return node;
        }

        if (this.parent) return this.parent.lookupSymbol(name);

        return undefined;
    }

    lookupTypeSymbol(name: string): TypeNode | undefined {
        for (const nodeId of this.ownSymbols) {
            const node = this.symbols.get(nodeId);
            if (!node || node.name !== name) continue;
            if (node instanceof TypeNode) return node;
        }

        if (this.parent) return this.parent.lookupTypeSymbol(name);

        return undefined;
    }

    lookupSiblingModule(name: string): Module | undefined {
        for (const nodeId of this.ownSymbols) {
            const node = this.symbols.get(nodeId);
            if (node && node instanceof Module && node.name === name) return node;
        }

        if (this.parent) return this.parent.lookupSiblingModule(name);

        return undefined;
    }

    getSymbol(id: string): NamedNode | undefined {
        return this.symbols.get(id);
    }
}

export class AST extends ContainerNode { }

export class Module extends ContainerNode implements NamedNode {
    readonly name: string;

    constructor(opts: {
        name: string,
        parent?: ContainerNode,
    }) {
        super({ ...opts, flags: [] });
        this.name = opts.name;
    }

    sub(name: string): Module {
        const module = new Module({ name, parent: this });
        this.pushChild(module);
        return module;
    }
}

export class FolderModule extends Module { }

export class FileModule extends Module { }

export abstract class TypeNode extends ContainerNode implements NamedNode {
    readonly name: string;

    constructor(opts: {
        name: string,
        flags: string[],
        parent?: ContainerNode,
    }) {
        super(opts);
        this.name = opts.name;
    }

    toJSON(): object {
        return { name: this.name, ...super.toJSON() };
    }
}

export abstract class TypedNode extends NamedNode {
    resolvedType?: TypeNode;

    get type(): TypeNode {
        if (!this.resolvedType) {
            throw new Error(`Type not yet resolved: ${this.name}`);
        }
        return this.resolvedType;
    }

    resolveType(type: TypeNode): void {
        this.resolvedType = type;
    }
}

/** Note, variables are detected and added using insertSymbol in the scanning phase */
export class FunctionNode extends TypeNode {
    readonly name: string;
    readonly parameters: Parameter[];
    readonly variables: Variable[] = [];
    readonly returnTypeName?: string;
    resolvedReturnType?: TypeNode;
    expression?: ExpressionNode;

    constructor(opts: {
        name: string,
        parent: ContainerNode,
        flags: string[],
        parameters: Parameter[];
        returnTypeName?: string;
    }) {
        super(opts);
        this.name = opts.name;
        this.parameters = opts.parameters;
        this.returnTypeName = opts.returnTypeName;
        this.parameters.forEach(p => this.insertSymbol(p));
    }

    get nextLocalIndex(): number {
        return this.parameters.length + this.variables.length
    }

    get returnType(): TypeNode {
        if (!this.resolvedReturnType) throw new Error("Return type not yet resolved for this function");
        return this.resolvedReturnType;
    }

    resolveReturnType(type: TypeNode): void {
        this.resolvedReturnType = type;
    }

    addThisParameter(type: string, parent: ContainerNode): void {
        const thisParam = new Parameter({
            name: "this", flags: ["this"], parent, typeName: type,
            localIndex: 0
        })
        this.parameters.unshift(thisParam);
        this.parameters.forEach((p, i) => p.localIndex = i);
        this.insertSymbol(thisParam);
    }

    toJSON(): object {
        return {
            ...super.toJSON(),
            parameters: this.parameters,
            returnType: this.returnTypeName,
            expression: this.expression
        }
    }
}

export class Parameter extends TypedNode {
    readonly parent: ContainerNode;
    readonly initializer?: ExpressionNode;
    readonly typeName?: string;
    localIndex: number;

    constructor(opts: {
        name: string,
        localIndex: number,
        flags: string[],
        parent: ContainerNode,
        typeName?: string;
        initializer?: ExpressionNode
    }) {
        super(opts);
        this.parent = opts.parent;
        this.localIndex = opts.localIndex;
        this.initializer = opts.initializer;
        this.typeName = opts.typeName;
    }

    toJSON(): object {
        return { name: this.name, initializer: this.initializer, type: this.typeName };
    }
}

export class Enum extends TypeNode {
    private readonly resolvedVariants: EnumVariant[] = [];

    constructor(opts: {
        name: string,
        flags: string[],
        parent?: ContainerNode,
    }) {
        super(opts)
    }

    get variants(): EnumVariant[] {
        return this.resolvedVariants;
    }

    pushVariant(...variant: EnumVariant[]): void {
        this.resolvedVariants.push(...variant);
    }

    insertSymbol(node: NamedNode): void {
        super.insertSymbol(node);

        if (node instanceof EnumVariant) {
            this.resolvedVariants.push(node);
        }
    }

    toJSON(): object {
        return { ...super.toJSON(), variants: this.variants };
    }
}

export class EnumVariant extends NamedNode {
    readonly associatedType?: TypeNode;
    readonly parent: Enum;
    readonly num: number;

    constructor(opts: {
        name: string,
        flags: string[],
        associatedType?: TypeNode,
        parent: Enum,
        num: number
    }) {
        super(opts);
        this.parent = opts.parent; // May not be necessary.
        this.associatedType = opts.associatedType;
        this.num = opts.num;
    }
}

export class TypeAlias extends TypeNode {
    resolvedType?: TypeNode;

    type(): TypeNode {
        if (!this.resolvedType) {
            throw new Error("Type not yet resolved.");
        }
        return this.resolvedType;
    }

    resolveType(type: TypeNode): void {
        this.resolvedType = type;
    }
}

export class Struct extends TypeNode {
    fields: Field[] = [];

    constructor(opts: {
        name: string,
        flags: string[],
        parent?: ContainerNode,
    }) {
        super(opts)
    }

    toJSON(): object {
        return { ...super.toJSON(), fields: this.fields };
    }
}

export class Field extends TypedNode {
    readonly initializer?: ExpressionNode;
    parent: Struct;

    constructor(opts: {
        name: string,
        flags: string[],
        parent: Struct,
        initializer?: ExpressionNode
    }) {
        super(opts);
        this.parent = opts.parent; // May not be necessary.
        this.initializer = opts.initializer;
    }
}

export class Impl extends TypeNode {
    private resolvedTarget?: TypeNode;
    readonly targetName: string;
    readonly traitName?: string;
    readonly functions: FunctionNode[] = [];

    constructor(opts: {
        targetName: string,
        traitName?: string,
        flags: string[],
        parent: ContainerNode
    }) {
        super({
            name: `impl ${opts.targetName}`,
            parent: opts.parent,
            flags: opts.flags,
        });
        this.targetName = opts.targetName;
        this.traitName = opts.traitName
    }

    pushFn(fn: FunctionNode): void {
        this.functions.push(fn);
    }

    target(): TypeNode {
        if (!this.resolvedTarget) {
            throw new Error("Target not yet resolved for impl");
        }
        return this.resolvedTarget;
    }

    resolveTarget(target: TypeNode): void {
        this.resolvedTarget = target;
    }

    toJSON(): object {
        return {
            ...super.toJSON(),
            target: this.targetName,
            trait: this.traitName,
            functions: this.functions
        };
    }
}

export class Variable extends TypedNode {
    readonly flags: string[];
    readonly initializer?: ExpressionNode;
    readonly tokenIndex: number;
    readonly typeName?: string;
    readonly parent: ContainerNode;
    localIndex?: number;

    constructor(opts: {
        name: string;
        flags: string[];
        tokenIndex: number;
        typeName?: string;
        initializer?: ExpressionNode;
        parent: ContainerNode;
    }) {
        super(opts);
        this.flags = opts.flags;
        this.initializer = opts.initializer;
        this.tokenIndex = opts.tokenIndex;
        this.parent = opts.parent;
    }
}

export class Break extends StatementNode { }
export class Continue extends StatementNode { }

export class Return extends StatementNode {
    readonly expression?: ExpressionNode;

    constructor(opts: {
        parent: ContainerNode,
        expression?: ExpressionNode
    }) {
        super(opts.parent);
        this.expression = opts.expression;
    }
}

export class Use extends StatementNode {
    readonly parent: ContainerNode;
    readonly flags: string[];
    readonly tree: UseTree;

    constructor({ parent, flags, tree }: {
        parent: ContainerNode;
        flags: string[];
        tree: UseTree;
    }) {
        super(parent);
        this.flags = flags;
        this.tree = tree;
        this.parent = parent;
    }

    toJSON(): object {
        return { ...super.toJSON(), tree: this.tree };
    }
}

export interface UseTree {
    path: Identifier[];
    node:
    { kind: "wildcard" } |
    { kind: "alias", alias: Identifier } |
    { kind: "branched", branches: UseTree[] } |
    { kind: "self" }
}

export class Block extends ContainerNode implements ExpressionNode {
    readonly children: ExpressionNode[] = [];
    readonly flags: string[];
    parent: ContainerNode;


    constructor(parent: ContainerNode, flags: string[] = []) {
        super(parent);
        this.parent = parent;
        this.flags = flags;
    }

    protected getParentFunction(parent = this.parent): FunctionNode {
        if (parent instanceof FunctionNode) return parent;
        if (!parent.parent) {
            throw new Error("Block is not an descendent of a module.");
        }
        return this.getParentFunction(parent.parent);
    }

    lastChild(): ExpressionNode | undefined {
        if (!this.children.length) return;
        return this.children[this.children.length - 1];
    }
}

export class Identifier extends ExpressionNode implements NamedNode {
    private resolvedRef?: NamedNode;
    readonly tokenIndex: number;
    readonly name: string;
    readonly flags: string[];

    constructor(opts: {
        name: string,
        tokenIndex: number,
        flags?: string[],
        parent: ContainerNode
    }) {
        super(opts.parent);
        this.tokenIndex = opts.tokenIndex;
        this.name = opts.name;
        this.flags = opts.flags ?? [];
    }

    ref(): NamedNode {
        if (!this.resolvedRef) {
            throw new Error("Identifer has not yet been resolved");
        }
        return this.resolvedRef;
    }

    resolve(ref: NamedNode): void {
        this.resolvedRef = ref;
    }

    toJSON(): object {
        return { ...super.toJSON(), name: this.name };
    }
}

export class While extends ExpressionNode {
    readonly condition: ExpressionNode;
    readonly block: Block;

    constructor(opts: {
        parent: ContainerNode,
        condition: ExpressionNode,
        block: Block
    }) {
        super(opts.parent);
        this.condition = opts.condition;
        this.block = opts.block;
    }

    toJSON(): object {
        return { ...super.toJSON(), condition: this.condition, block: this.block };
    }
}

export class If extends ExpressionNode {
    readonly condition: ExpressionNode;
    readonly block: Block;
    readonly elifs: { condition: ExpressionNode, block: Block }[] = [];
    elseBlock?: Block;

    constructor(opts: {
        condition: ExpressionNode,
        parent: ContainerNode,
        block: Block
    }) {
        super(opts.parent);
        this.condition = opts.condition;
        this.block = opts.block;
    }

    pushElif(elif: { condition: ExpressionNode, block: Block }): void {
        this.elifs.push(elif);
    }

    toJSON(): object {
        return {
            condition: this.condition, block: this.block, elifs: this.elifs,
            elseBlock: this.elseBlock
        };
    }
}

export class Call extends ExpressionNode {
    resolvedCallee?: FunctionNode;
    argumentTypes?: TypeNode[];
    readonly calleeName: string;
    readonly arguments: ExpressionNode[];

    constructor(opts: {
        parent: ContainerNode,
        calleeName: string,
        arguments: ExpressionNode[];
    }) {
        super(opts.parent);
        this.calleeName = opts.calleeName;
        this.arguments = opts.arguments;
    }

    get callee(): FunctionNode {
        if (!this.resolvedCallee) {
            throw new Error("Callee not yet resolved");
        }

        return this.resolvedCallee;
    }

    toJSON(): object {
        return { ...super.toJSON(), callee: this.calleeName, arguments: this.arguments }
    }

    resolveCallee(fn: FunctionNode): void {
        this.resolvedCallee = fn;
    }
}

export class BinaryExpression extends Call { }

export class Assignment extends ExpressionNode {
    readonly assignee: PropertyAccess | Identifier | Variable;
    readonly expression: ExpressionNode;

    constructor({ assignee, expression, parent }: {
        parent: ContainerNode;
        assignee: PropertyAccess | Identifier | Variable;
        expression: ExpressionNode;
    }) {
        super(parent);
        this.assignee = assignee;
        this.expression = expression;
    }

    toJSON(): object {
        return { ...super.toJSON(), assignee: this.assignee, expression: this.expression };
    }
}

export class PropertyAccess extends ExpressionNode {
    readonly left: ExpressionNode;
    readonly right: ExpressionNode;

    constructor({ left, right, parent }: {
        parent: ContainerNode;
        left: ExpressionNode;
        right: ExpressionNode;
    }) {
        super(parent);
        this.left = left;
        this.right = right;
    }

    toJSON(): object {
        return { ...super.toJSON(), left: this.left, right: this.right };
    }
}

export class IntLiteral extends ExpressionNode {
    readonly value: number;

    constructor({ parent, value }: {
        parent: ContainerNode;
        value: string;
    }) {
        super(parent);
        this.value = parseInt(value);
    }

    toJSON(): object {
        return { ...super.toJSON(), value: this.value };
    }
}

export class FloatLiteral extends ExpressionNode {
    readonly value: number;

    constructor({ parent, value }: {
        parent: ContainerNode;
        value: string;
    }) {
        super(parent);
        this.value = parseFloat(value);
    }

    toJSON(): object {
        return { ...super.toJSON(), value: this.value };
    }
}

export class StringLiteral extends ExpressionNode {
    readonly value: string;

    constructor({ parent, value }: {
        parent: ContainerNode;
        value: string;
    }) {
        super(parent);
        this.value = value;
    }

    toJSON(): object {
        return { ...super.toJSON(), value: this.value };
    }
}

export class BoolLiteral extends ExpressionNode {
    readonly value: string;

    constructor({ parent, value }: {
        parent: ContainerNode;
        value: string;
    }) {
        super(parent);
        this.value = value;
    }

    toJSON(): object {
        return { ...super.toJSON(), value: this.value };
    }
}

export class StructLiteral extends TypeNode implements ExpressionNode {
    readonly fields: { [name: string]: StructLiteralField } = {};
    readonly flags: string[];
    private currentFieldIndex = 0;

    constructor(opts: {
        flags: string[],
        parent: ContainerNode,
    }) {
        super({ ...opts, name: `struct literal ${uniqid()}` });
        this.flags = opts.flags;
    }

    addField(opts: {
        name: string,
        initializer: ExpressionNode,
        flags: string[]
    }): void {
        const field = new StructLiteralField({ ...opts, parent: this, index: this.currentFieldIndex });
        this.fields[opts.name] = field;
        this.insertSymbol(field);
        this.currentFieldIndex += 1;
    }

    toJSON(): object {
        return { ...super.toJSON(), fields: this.fields, flags: this.flags };
    }
}

export class StructLiteralField extends TypedNode {
    parent: StructLiteral;
    initializer: ExpressionNode;
    index: number;

    constructor(opts: {
        name: string,
        flags: string[],
        parent: StructLiteral,
        initializer: ExpressionNode,
        index: number
    }) {
        super(opts);
        this.parent = opts.parent;
        this.initializer = opts.initializer;
        this.index = opts.index;
    }

    toJSON(): object {
        return { ...super.toJSON(), initializer: this.initializer }
    }
}
