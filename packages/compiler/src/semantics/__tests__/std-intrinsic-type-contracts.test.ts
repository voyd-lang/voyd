import { describe, expect, it } from "vitest";
import {
  STD_INTRINSIC_TYPE,
  getStdIntrinsicTypeContractSpec,
} from "../../compiler-contracts/index.js";
import type {
  ModuleGraph,
  ModuleNode,
  ModulePath,
} from "../../modules/types.js";
import { parse } from "../../parser/index.js";
import { getSymbolTable } from "../_internal/symbol-table.js";
import { semanticsPipeline } from "../pipeline.js";

const analyze = ({ source, path }: { source: string; path: ModulePath }) => {
  const moduleId = `${path.namespace}::${path.segments.join("::")}`;
  const ast = parse(source, `${moduleId}.voyd`);
  const module: ModuleNode = {
    id: moduleId,
    path,
    origin: { kind: "file", filePath: `${moduleId}.voyd` },
    ast,
    source,
    dependencies: [],
  };
  const graph: ModuleGraph = {
    entry: moduleId,
    modules: new Map([[moduleId, module]]),
    diagnostics: [],
  };
  return semanticsPipeline({ module, graph });
};

describe("reserved std intrinsic type contracts", () => {
  it("binds typed roles for std nominal object providers", () => {
    const semantics = analyze({
      source: `@intrinsic_type(type: "${STD_INTRINSIC_TYPE.array}")
obj ArrayProvider {}

@intrinsic_type(type: "${STD_INTRINSIC_TYPE.optionalSome}")
obj SomeProvider {}`,
      path: { namespace: "std", segments: ["intrinsic_contracts"] },
    });
    const symbols = getSymbolTable(semantics);
    const array = symbols.resolve("ArrayProvider", symbols.rootScope);
    const some = symbols.resolve("SomeProvider", symbols.rootScope);
    expect(array).toBeDefined();
    expect(some).toBeDefined();
    if (array === undefined || some === undefined) {
      return;
    }

    expect(semantics.symbols.getStdIntrinsicTypeContract(array)).toEqual({
      id: STD_INTRINSIC_TYPE.array,
      providerKind: "nominal-object",
    });
    expect(semantics.symbols.getStdIntrinsicTypeContract(some)).toEqual({
      id: STD_INTRINSIC_TYPE.optionalSome,
      providerKind: "nominal-object",
    });
    expect(
      semantics.symbols.resolveStdIntrinsicTypeContract(
        STD_INTRINSIC_TYPE.array,
      ),
    ).toBe(array);
    expect(getStdIntrinsicTypeContractSpec(STD_INTRINSIC_TYPE.array)).toEqual({
      id: STD_INTRINSIC_TYPE.array,
      providerKinds: ["nominal-object"],
      outsideStd: "reject",
    });
  });

  it("rejects reserved roles outside std and on non-nominal providers", () => {
    expect(() =>
      analyze({
        source: `@intrinsic_type(type: "${STD_INTRINSIC_TYPE.array}")
obj UserArray {}`,
        path: { namespace: "src", segments: ["reserved_array"] },
      }),
    ).toThrow(/restricted to the std namespace and package/);

    expect(() =>
      analyze({
        source: `@intrinsic_type(type: "${STD_INTRINSIC_TYPE.string}")
type StringAlias = i32`,
        path: { namespace: "std", segments: ["invalid_alias"] },
      }),
    ).toThrow(/must annotate a nominal object, not a type-alias/);

    expect(() =>
      analyze({
        source: `@intrinsic_type(type: "${STD_INTRINSIC_TYPE.range}")
trait RangeTrait
  fn value(self) -> i32`,
        path: { namespace: "std", segments: ["invalid_trait"] },
      }),
    ).toThrow(/must annotate a nominal object, not a trait/);

    expect(() =>
      analyze({
        source: `@intrinsic_type(type: "${STD_INTRINSIC_TYPE.optionalNone}")
val NoneValue {}`,
        path: { namespace: "std", segments: ["invalid_optional_value"] },
      }),
    ).toThrow(/must annotate a nominal object, not a value-object/);
  });

  it("keeps legacy and unrelated intrinsic type metadata general", () => {
    const semantics = analyze({
      source: `@intrinsic_type(type: "${STD_INTRINSIC_TYPE.optionalSome}")
obj SomeProvider {
  value: i32
}

@intrinsic_type(type: "optional")
type OptionalAlias = SomeProvider

@intrinsic_type(type: "package.custom-role")
obj CustomProvider {}`,
      path: { namespace: "src", segments: ["general_intrinsics"] },
    });
    const symbols = getSymbolTable(semantics);
    const some = symbols.resolve("SomeProvider", symbols.rootScope);
    const optional = symbols.resolve("OptionalAlias", symbols.rootScope);
    const custom = symbols.resolve("CustomProvider", symbols.rootScope);
    expect(some).toBeDefined();
    expect(optional).toBeDefined();
    expect(custom).toBeDefined();
    if (some === undefined || optional === undefined || custom === undefined) {
      return;
    }

    expect(semantics.symbols.getIntrinsicType(some)).toBe("optional-some");
    expect(semantics.symbols.getIntrinsicType(optional)).toBe("optional");
    expect(semantics.symbols.getIntrinsicType(custom)).toBe(
      "package.custom-role",
    );
    expect(semantics.symbols.getStdIntrinsicTypeContract(some)).toBeUndefined();
    expect(
      semantics.symbols.getStdIntrinsicTypeContract(optional),
    ).toBeUndefined();
    expect(
      semantics.symbols.getStdIntrinsicTypeContract(custom),
    ).toBeUndefined();
  });
});
