import {
  diagnosticFromCode,
  type DiagnosticParams,
} from "../../diagnostics/index.js";
import type { SymbolTable } from "../binder/index.js";
import type {
  HirContractPlace,
  HirGraph,
  HirImplDecl,
  HirTraitDecl,
  HirTraitMethod,
  HirTypeExpr,
} from "../hir/index.js";
import type { SourceSpan, SymbolId, TypeId } from "../ids.js";
import type { TypingResult } from "../typing/index.js";
import { borrowedPathsInType } from "./borrowed-types.js";
import { typeContainsBorrowed } from "./borrowed-types.js";
import type {
  BorrowingResult,
  CallableBorrowContract,
  CheckedNamedBorrowContract,
  PlaceProjection,
} from "./model.js";
import {
  mappedAllocationCoversReturnedBorrow,
  projectionPathCovers,
  projectionPathsOverlap,
} from "./model.js";
import {
  referenceOriginsInType,
  retainableReferencePathsInType,
  typeCanCarryReference,
  typeIsDefinitelyAllocationBacked,
} from "./reference-bearing.js";

type NamedContractValidation = {
  contracts: ReadonlyMap<SymbolId, CheckedNamedBorrowContract>;
  declarationCallables: ReadonlyMap<SymbolId, CallableBorrowContract>;
  diagnostics: BorrowingResult["diagnostics"];
};

type DeclaredContract = {
  trait: HirTraitDecl;
  method: HirTraitMethod;
  hasBorrowedResult: boolean;
  reads: readonly string[];
  mutates: readonly string[];
  returnsFrom: readonly string[];
};

type ResolvedRegion = {
  name: string;
  place: readonly PlaceProjection[];
  display: string;
  storage: ResolvedContractStorage;
};

type ResolvedContractStorage = {
  identity:
    | { kind: "receiver" }
    | { kind: "dereference"; source: readonly PlaceProjection[] };
  allocationTypes: readonly TypeId[];
  relativePlace: readonly PlaceProjection[];
};

export const validateNamedBorrowContracts = ({
  hir,
  typing,
  symbolTable,
  callables,
  moduleId,
  imports,
  validateBodies = true,
}: {
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  callables: ReadonlyMap<SymbolId, CallableBorrowContract>;
  moduleId: string;
  imports: readonly {
    local: SymbolId;
    target?: { moduleId: string };
  }[];
  validateBodies?: boolean;
}): NamedContractValidation => {
  const diagnostics: BorrowingResult["diagnostics"][number][] = [];
  const checked = new Map<SymbolId, CheckedNamedBorrowContract>();
  const traits = Array.from(hir.items.values()).filter(
    (item): item is HirTraitDecl => item.kind === "trait",
  );
  const declared = new Map<SymbolId, DeclaredContract>();

  traits.forEach((trait) => {
    validateTraitDeclaration({
      trait,
      typing,
      symbolTable,
      callables,
      moduleId,
      imports,
      validateBodies,
      diagnostics,
      declared,
      checked,
    });
  });

  const impls = Array.from(hir.items.values()).filter(
    (item): item is HirImplDecl => item.kind === "impl",
  );
  impls.forEach((impl) =>
    validateImpl({
      impl,
      hir,
      typing,
      symbolTable,
      callables,
      declared,
      checked,
      diagnostics,
      moduleId,
      imports,
      validateBodies,
    }),
  );
  const implMembers = new Set(
    impls.flatMap((impl) =>
      impl.members.flatMap((memberId) => {
        const member = hir.items.get(memberId);
        return member?.kind === "function" ? [member.symbol] : [];
      }),
    ),
  );
  Array.from(hir.items.values()).forEach((item) => {
    if (
      item.kind !== "function" ||
      !item.borrowContract ||
      implMembers.has(item.symbol)
    ) {
      return;
    }
    diagnostics.push(
      contractDiagnostic({
        kind: "invalid-contract-target",
        declaration: symbolTable.getSymbol(item.symbol).name,
        span: item.span,
      }),
    );
  });

  return {
    contracts: checked,
    declarationCallables: declaredCallableContracts({
      hir,
      typing,
      contracts: checked,
    }),
    diagnostics,
  };
};

const declaredCallableContracts = ({
  hir,
  typing,
  contracts,
}: {
  hir: HirGraph;
  typing: TypingResult;
  contracts: ReadonlyMap<SymbolId, CheckedNamedBorrowContract>;
}): ReadonlyMap<SymbolId, CallableBorrowContract> => {
  const declarations = Array.from(hir.items.values()).flatMap((item) =>
    item.kind === "trait" ? item.methods : [],
  );
  return new Map<SymbolId, CallableBorrowContract>(
    declarations.flatMap(
      (method): readonly (readonly [SymbolId, CallableBorrowContract])[] => {
        const named = contracts.get(method.symbol);
        const implementationSymbol = Array.from(
          typing.traitMethodImpls.entries(),
        ).find(
          ([, mapping]) => mapping.traitMethodSymbol === method.symbol,
        )?.[0];
        const signature =
          typing.functions.getSignature(method.symbol) ??
          (typeof implementationSymbol === "number"
            ? typing.functions.getSignature(implementationSymbol)
            : undefined);
        if (named?.implementation !== undefined) {
          return [];
        }
        const returnType =
          signature?.returnType ?? declaredTypeId(method.returnType, typing);
        if (!named) {
          const resultOrigins =
            typeof returnType === "number"
              ? referenceOriginsInType(returnType, typing)
              : [];
          const parameters = method.parameters.map((parameter, index) => {
            const signatureParameter = signature?.parameters[index];
            const parameterType =
              signatureParameter?.type ?? parameter.type?.typeId;
            const reference =
              index === 0 ||
              (typeof parameterType === "number" &&
                typeCanCarryReference(parameterType, typing));
            const access =
              (signatureParameter?.bindingKind ?? parameter.bindingKind) ===
              "mutable-ref"
                ? ("mutable" as const)
                : reference
                  ? ("shared" as const)
                  : ("owned" as const);
            const returnedOrigins =
              reference && typeof parameterType === "number"
                ? referenceOriginsInType(parameterType, typing).flatMap(
                    (source) =>
                      resultOrigins.map((result) => ({
                        source: source.path,
                        result: result.path,
                        endpointAccess: source.endpointAccess,
                      })),
                  )
                : [];
            return {
              access,
              ...(access === "shared" ? { readPaths: [[]] } : {}),
              ...(access === "mutable" ? { writePaths: [[]] } : {}),
              retained: reference && access !== "mutable",
              ...(reference && access !== "mutable"
                ? {
                    retainedUnlessBorrowed: true as const,
                    retainedPaths: [[]],
                    externalRetainedPaths: [[]],
                  }
                : {}),
              returned: returnedOrigins.length > 0,
              ...(returnedOrigins.length > 0 ? { returnedOrigins } : {}),
            };
          });
          return [
            [
              method.symbol,
              {
                parameters,
                maySuspend: signature
                  ? !typing.effects.isEmpty(signature.effectRow)
                  : method.effectType !== undefined,
                borrowedResult:
                  typeof returnType === "number" &&
                  borrowedPathsInType(returnType, typing).length > 0
                    ? ("external" as const)
                    : ("none" as const),
                ...(resultOrigins.length > 0
                  ? {
                      externalReturnedOrigins: resultOrigins.map((result) => ({
                        result: result.path,
                        endpointAccess: result.endpointAccess,
                      })),
                    }
                  : {}),
              },
            ] as const,
          ];
        }
        const disjointFor = (region: string): readonly string[] =>
          named.disjoint.flatMap(([left, right]) =>
            left === region ? [right] : right === region ? [left] : [],
          );
        const regionPath = (name: string): readonly PlaceProjection[] => [
          {
            kind: "region",
            scope: named.scope,
            name,
            disjoint: disjointFor(name),
          },
        ];
        const borrowedResultPaths = Array.from(
          new Map(
            [
              ...(typeof returnType === "number"
                ? borrowedPathsInType(returnType, typing)
                : []),
              ...borrowedPathsInTypeExpression(method.returnType, typing),
            ].map((path) => [JSON.stringify(path), path]),
          ).values(),
        );
        const returnedOrigins = named.returnsFrom.flatMap((region) =>
          borrowedResultPaths.map((result) => ({
            source: regionPath(region),
            result,
            endpointAccess: "inline" as const,
          })),
        );
        const resultCarriesReference =
          typeof returnType === "number" &&
          typeCanCarryReference(returnType, typing);
        const resultReferencePaths =
          typeof returnType === "number"
            ? retainableReferencePathsInType(returnType, typing)
            : [];
        const parameters = method.parameters.map((parameter, index) => {
          const signatureParameter = signature?.parameters[index];
          const parameterType =
            signatureParameter?.type ?? parameter.type?.typeId;
          const reference =
            typeof parameterType === "number" &&
            typeCanCarryReference(parameterType, typing);
          const containsExplicitBorrow =
            typeof parameterType === "number"
              ? typeContainsBorrowed(parameterType, typing)
              : typeExprContainsBorrowed(parameter.type, typing);
          const ordinarySources =
            reference && typeof parameterType === "number"
              ? referenceOriginsInType(parameterType, typing)
              : [];
          const retainablePaths =
            typeof parameterType === "number"
              ? retainableReferencePathsInType(parameterType, typing)
              : [];
          const receiverRegionSources =
            index === 0 && resultCarriesReference
              ? named.regions.map((region) => ({
                  path: regionPath(region.name),
                  endpointAccess: "inline" as const,
                }))
              : [];
          const ordinaryReturnedOrigins = resultCarriesReference
            ? [...ordinarySources, ...receiverRegionSources].flatMap((source) =>
                resultReferencePaths.map((result) => ({
                  source: source.path,
                  result,
                  endpointAccess: source.endpointAccess,
                })),
              )
            : [];
          const access =
            (signatureParameter?.bindingKind ?? parameter.bindingKind) ===
            "mutable-ref"
              ? ("mutable" as const)
              : reference
                ? ("shared" as const)
                : ("owned" as const);
          const ordinaryRetainedPaths =
            access === "mutable" ? [] : retainablePaths;
          if (index === 0) {
            const retained = reference && access !== "mutable";
            return {
              access,
              readPaths: named.reads.map(regionPath),
              writePaths: named.mutates.map(regionPath),
              retained,
              ...(retained
                ? {
                    retainedUnlessBorrowed: true as const,
                    retainedPaths: [[]],
                    externalRetainedPaths: [[]],
                  }
                : {}),
              returned:
                returnedOrigins.length > 0 ||
                ordinaryReturnedOrigins.length > 0,
              ...(returnedOrigins.length > 0 ||
              ordinaryReturnedOrigins.length > 0
                ? {
                    ...(returnedOrigins.length > 0 &&
                    method.returnType?.typeKind !== "borrowed"
                      ? { returnedAggregate: true as const }
                      : {}),
                    returnedOrigins: [
                      ...returnedOrigins,
                      ...ordinaryReturnedOrigins,
                    ],
                    ...(returnedOrigins.length > 0
                      ? { returnedSharedOrigins: returnedOrigins }
                      : {}),
                  }
                : {}),
            };
          }
          return {
            access,
            ...(access === "shared" ? { readPaths: [[]] } : {}),
            ...(access === "mutable" ? { writePaths: [[]] } : {}),
            retained: ordinaryRetainedPaths.length > 0,
            ...(ordinaryRetainedPaths.length > 0
              ? {
                  ...(!containsExplicitBorrow
                    ? { retainedUnlessBorrowed: true as const }
                    : {}),
                  retainedPaths: ordinaryRetainedPaths,
                  externalRetainedPaths: ordinaryRetainedPaths,
                }
              : {}),
            returned: ordinaryReturnedOrigins.length > 0,
            ...(ordinaryReturnedOrigins.length > 0
              ? { returnedOrigins: ordinaryReturnedOrigins }
              : {}),
          };
        });
        return [
          [
            method.symbol,
            {
              parameters,
              maySuspend: signature
                ? !typing.effects.isEmpty(signature.effectRow)
                : method.effectType !== undefined,
              borrowedResult:
                borrowedResultPaths.length > 0 ? "parameter" : "none",
            },
          ] as const,
        ];
      },
    ),
  );
};

const declaredContractForMethod = ({
  trait,
  method,
  typing,
}: {
  trait: HirTraitDecl;
  method: HirTraitMethod | undefined;
  typing: TypingResult;
}): DeclaredContract | undefined => {
  if (!method?.borrowContract) {
    return undefined;
  }
  const returnType = declaredTypeId(method.returnType, typing);
  return {
    trait,
    method,
    hasBorrowedResult:
      typeExprContainsBorrowed(method.returnType, typing) ||
      (typeof returnType === "number" &&
        borrowedPathsInType(returnType, typing).length > 0),
    reads: unique(method.borrowContract.reads ?? []),
    mutates: unique(method.borrowContract.mutates ?? []),
    returnsFrom: unique(method.borrowContract.returnsFrom ?? []),
  };
};

const validateTraitDeclaration = ({
  trait,
  typing,
  symbolTable,
  callables,
  diagnostics,
  declared,
  checked,
  moduleId,
  imports,
  validateBodies,
}: {
  trait: HirTraitDecl;
  typing: TypingResult;
  symbolTable: SymbolTable;
  callables: ReadonlyMap<SymbolId, CallableBorrowContract>;
  diagnostics: BorrowingResult["diagnostics"][number][];
  declared: Map<SymbolId, DeclaredContract>;
  checked: Map<SymbolId, CheckedNamedBorrowContract>;
  moduleId: string;
  imports: readonly {
    local: SymbolId;
    target?: { moduleId: string };
  }[];
  validateBodies: boolean;
}): void => {
  const declarationName = symbolTable.getSymbol(trait.symbol).name;
  const regionNames = new Set<string>();
  (trait.regions ?? []).forEach((region) => {
    if (regionNames.has(region.name)) {
      diagnostics.push(
        contractDiagnostic({
          kind: "duplicate-region",
          declaration: declarationName,
          region: region.name,
          span: region.span,
        }),
      );
      return;
    }
    regionNames.add(region.name);
  });

  const declaredDisjoint = disjointPairs(trait.disjoint ?? []);
  declaredDisjoint.forEach(([left, right, span]) => {
    if (left === right) {
      diagnostics.push(
        contractDiagnostic({
          kind: "self-disjointness",
          declaration: declarationName,
          region: left,
          span,
        }),
      );
    }
    [left, right].forEach((region) => {
      if (regionNames.has(region)) {
        return;
      }
      diagnostics.push(
        contractDiagnostic({
          kind: "unknown-region",
          declaration: declarationName,
          region,
          clause: "disjoint",
          span,
        }),
      );
    });
  });
  const disjoint = declaredDisjoint.filter(
    ([left, right]) =>
      left !== right && regionNames.has(left) && regionNames.has(right),
  );

  trait.methods.forEach((method) => {
    const methodName = symbolTable.getSymbol(method.symbol).name;
    const contract = method.borrowContract;
    const returnType = declaredTypeId(method.returnType, typing);
    const hasBorrowedResult =
      typeExprContainsBorrowed(method.returnType, typing) ||
      (typeof returnType === "number" &&
        borrowedPathsInType(returnType, typing).length > 0);
    if (!contract) {
      if (hasBorrowedResult) {
        diagnostics.push(
          contractDiagnostic({
            kind: "missing-returns-from",
            declaration: methodName,
            span: method.span,
          }),
        );
      }
      return;
    }
    if (
      !method.parameters[0] ||
      symbolTable.getSymbol(method.parameters[0].symbol).name !== "self"
    ) {
      diagnostics.push(
        contractDiagnostic({
          kind: "static-contract-target",
          declaration: methodName,
          span: method.span,
        }),
      );
      return;
    }

    const reads = unique(contract.reads ?? []);
    const mutates = unique(contract.mutates ?? []);
    const returnsFrom = unique(contract.returnsFrom ?? []);
    (
      [
        ["reads", reads],
        ["mutates", mutates],
        ["returns_from", returnsFrom],
      ] as const
    ).forEach(([clause, regions]) =>
      regions.forEach((region) => {
        if (regionNames.has(region)) {
          return;
        }
        diagnostics.push(
          contractDiagnostic({
            kind: "unknown-region",
            declaration: methodName,
            region,
            clause,
            span: method.span,
          }),
        );
      }),
    );

    if (hasBorrowedResult && returnsFrom.length === 0) {
      diagnostics.push(
        contractDiagnostic({
          kind: "missing-returns-from",
          declaration: methodName,
          span: method.span,
        }),
      );
    }
    if (!hasBorrowedResult && returnsFrom.length > 0) {
      diagnostics.push(
        contractDiagnostic({
          kind: "returns-from-without-borrow",
          declaration: methodName,
          regions: returnsFrom.join(", "),
          span: method.span,
        }),
      );
    }

    declared.set(
      method.symbol,
      declaredContractForMethod({ trait, method, typing })!,
    );
    const callable = callables.get(method.symbol);
    if (validateBodies && typeof method.defaultBody === "number" && callable) {
      validateDefaultDeclarationSubset({
        callable,
        contract: declared.get(method.symbol)!,
        declaration: methodName,
        span: method.span,
        diagnostics,
      });
    }
    checked.set(method.symbol, {
      scope: namedContractScope({
        trait: trait.symbol,
        name: declarationName,
        moduleId,
        imports,
      }),
      declaration: method.symbol,
      trait: trait.symbol,
      regions: Array.from(regionNames, (name) => ({ name })),
      disjoint: disjoint.map(([left, right]) => [left, right]),
      reads,
      mutates,
      returnsFrom,
    });
  });
};

const validateDefaultDeclarationSubset = ({
  callable,
  contract,
  declaration,
  span,
  diagnostics,
}: {
  callable: CallableBorrowContract;
  contract: DeclaredContract;
  declaration: string;
  span: SourceSpan;
  diagnostics: BorrowingResult["diagnostics"][number][];
}): void => {
  const receiver = callable.parameters[0];
  const allowedReads = unique([
    ...contract.reads,
    ...contract.mutates,
    ...contract.returnsFrom,
  ]);
  (receiver?.readPaths ?? []).forEach((path) =>
    requireDeclaredRegionCovered({
      path,
      allowed: allowedReads,
      clause: "reads",
      declaration,
      span,
      diagnostics,
    }),
  );
  (receiver?.writePaths ?? []).forEach((path) =>
    requireDeclaredRegionCovered({
      path,
      allowed: contract.mutates,
      clause: "mutates",
      declaration,
      span,
      diagnostics,
    }),
  );
  if (receiver) {
    returnedBorrowOriginsForContract({
      parameter: receiver,
      parameterIndex: 0,
      contract,
    }).forEach((origin) =>
      requireDeclaredRegionCovered({
        path: origin.source,
        allowed: contract.returnsFrom,
        clause: "returns_from",
        declaration,
        span,
        diagnostics,
      }),
    );
  }
  if (contract.hasBorrowedResult && callable.borrowedResult === "external") {
    requireCovered({
      path: [],
      allowed: [],
      clause: "returns_from",
      declaration,
      span,
      diagnostics,
      placeOverride: "<external provenance>",
    });
  }
  callable.parameters.slice(1).forEach((parameter, parameterOffset) => {
    const parameterIndex = parameterOffset + 1;
    (parameter.writePaths ?? []).forEach((path) =>
      requireCovered({
        path,
        allowed: [],
        clause: "mutates",
        declaration,
        span,
        diagnostics,
        parameter: parameterIndex,
      }),
    );
    returnedBorrowOriginsForContract({
      parameter,
      parameterIndex,
      contract,
    }).forEach((origin) =>
      requireCovered({
        path:
          origin.endpointAccess === "dereferenced" &&
          origin.source.at(-1)?.kind !== "dereference"
            ? [...origin.source, { kind: "dereference" }]
            : origin.source,
        allowed: [],
        clause: "returns_from",
        declaration,
        span,
        diagnostics,
        parameter: parameterIndex,
      }),
    );
  });
};

const requireDeclaredRegionCovered = ({
  path,
  allowed,
  clause,
  declaration,
  span,
  diagnostics,
}: {
  path: readonly PlaceProjection[];
  allowed: readonly string[];
  clause: "reads" | "mutates" | "returns_from";
  declaration: string;
  span: SourceSpan;
  diagnostics: BorrowingResult["diagnostics"][number][];
}): void => {
  const region = path[0];
  if (region?.kind === "region" && allowed.includes(region.name)) {
    return;
  }
  diagnostics.push(
    contractDiagnostic({
      kind: "contract-excess",
      declaration,
      clause,
      place: formatPlace(path),
      regions: allowed.length > 0 ? allowed.join(", ") : "<none>",
      span,
    }),
  );
};

const validateImpl = ({
  impl,
  hir,
  typing,
  symbolTable,
  callables,
  declared,
  checked,
  diagnostics,
  moduleId,
  imports,
  validateBodies,
}: {
  impl: HirImplDecl;
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  callables: ReadonlyMap<SymbolId, CallableBorrowContract>;
  declared: ReadonlyMap<SymbolId, DeclaredContract>;
  checked: Map<SymbolId, CheckedNamedBorrowContract>;
  diagnostics: BorrowingResult["diagnostics"][number][];
  moduleId: string;
  imports: readonly {
    local: SymbolId;
    target?: { moduleId: string };
  }[];
  validateBodies: boolean;
}): void => {
  const traitSymbol =
    impl.trait?.typeKind === "named" ? impl.trait.symbol : undefined;
  impl.members.forEach((memberId) => {
    const member = hir.items.get(memberId);
    if (member?.kind !== "function" || !member.borrowContract) {
      return;
    }
    diagnostics.push(
      contractDiagnostic({
        kind:
          typeof traitSymbol === "number"
            ? "implementation-contract"
            : "invalid-contract-target",
        declaration: symbolTable.getSymbol(member.symbol).name,
        span: member.span,
      }),
    );
  });
  if (typeof traitSymbol !== "number") {
    (impl.regionMappings ?? []).forEach((mapping) => {
      diagnostics.push(
        contractDiagnostic({
          kind: "invalid-region-mapping",
          declaration: symbolTable.getSymbol(impl.symbol).name,
          region: mapping.name,
          place: mapping.display,
          reason: "region mappings require a trait implementation",
          span: mapping.span,
        }),
      );
    });
    return;
  }

  const trait =
    Array.from(hir.items.values()).find(
      (item): item is HirTraitDecl =>
        item.kind === "trait" && item.symbol === traitSymbol,
    ) ?? typing.traits.getDecl(traitSymbol);
  if (!trait) {
    return;
  }
  const declarationName = `${symbolTable.getSymbol(traitSymbol).name} for ${
    impl.target.typeKind === "named" && typeof impl.target.symbol === "number"
      ? symbolTable.getSymbol(impl.target.symbol).name
      : symbolTable.getSymbol(impl.symbol).name
  }`;
  const declaredRegions = new Set(
    (trait.regions ?? []).map((region) => region.name),
  );
  const mappings = new Map<string, ResolvedRegion>();
  const providedMappings = new Set<string>();
  const targetType =
    impl.members
      .flatMap((memberId) => {
        const member = hir.items.get(memberId);
        const receiver =
          member?.kind === "function" ? member.parameters[0] : undefined;
        if (
          member?.kind !== "function" ||
          !receiver ||
          symbolTable.getSymbol(receiver.symbol).name !== "self"
        ) {
          return [];
        }
        const type = typing.functions.getSignature(member.symbol)?.parameters[0]
          ?.type;
        return typeof type === "number" ? [type] : [];
      })
      .at(0) ?? impl.target.typeId;

  (impl.regionMappings ?? []).forEach((mapping) => {
    if (providedMappings.has(mapping.name)) {
      diagnostics.push(
        contractDiagnostic({
          kind: "duplicate-region",
          declaration: declarationName,
          region: mapping.name,
          span: mapping.span,
        }),
      );
      return;
    }
    providedMappings.add(mapping.name);
    if (!declaredRegions.has(mapping.name)) {
      diagnostics.push(
        contractDiagnostic({
          kind: "unknown-region",
          declaration: declarationName,
          region: mapping.name,
          clause: "mapping",
          span: mapping.span,
        }),
      );
      return;
    }
    const resolved =
      mapping.place && typeof targetType === "number"
        ? resolveContractPlace(mapping.place, targetType, typing)
        : {
            ok: false as const,
            reason:
              typeof targetType === "number"
                ? "mapping is not a contract-place expression rooted at self"
                : "implementation target type is unresolved",
          };
    if (!resolved.ok) {
      diagnostics.push(
        contractDiagnostic({
          kind: "invalid-region-mapping",
          declaration: declarationName,
          region: mapping.name,
          place: mapping.display,
          reason: resolved.reason,
          span: mapping.span,
        }),
      );
      return;
    }
    mappings.set(mapping.name, {
      name: mapping.name,
      place: resolved.place,
      display: mapping.display,
      storage: resolved.storage,
    });
  });

  declaredRegions.forEach((region) => {
    if (providedMappings.has(region)) {
      return;
    }
    diagnostics.push(
      contractDiagnostic({
        kind: "missing-region-mapping",
        declaration: declarationName,
        region,
        span: impl.span,
      }),
    );
  });

  const disjoint = disjointPairs(trait.disjoint ?? []).filter(
    ([left, right]) =>
      left !== right && declaredRegions.has(left) && declaredRegions.has(right),
  );
  const verifiedDisjoint = disjoint.filter(([leftName, rightName, span]) => {
    const left = mappings.get(leftName);
    const right = mappings.get(rightName);
    if (!left || !right || !resolvedRegionsOverlap(left, right, typing)) {
      return Boolean(left && right);
    }
    diagnostics.push(
      contractDiagnostic({
        kind: "false-disjointness",
        declaration: declarationName,
        leftRegion: left.name,
        leftPlace: left.display,
        rightRegion: right.name,
        rightPlace: right.display,
        span,
      }),
    );
    return false;
  });

  impl.members.forEach((memberId) => {
    const member = hir.items.get(memberId);
    if (member?.kind !== "function") {
      return;
    }
    const mapping = typing.traitMethodImpls.get(member.symbol);
    const contract =
      mapping?.traitSymbol === traitSymbol
        ? (declared.get(mapping.traitMethodSymbol) ??
          declaredContractForMethod({
            trait,
            method: trait.methods.find(
              (method) => method.symbol === mapping.traitMethodSymbol,
            ),
            typing,
          }))
        : undefined;
    if (!contract) {
      return;
    }
    const callable = callables.get(member.symbol);
    if (validateBodies && callable) {
      validateCallableSubset({
        callable,
        contract,
        mappings,
        declaration: symbolTable.getSymbol(member.symbol).name,
        span: member.span,
        diagnostics,
      });
    }
    checked.set(member.symbol, {
      scope: namedContractScope({
        trait: traitSymbol,
        name: symbolTable.getSymbol(traitSymbol).name,
        moduleId,
        imports,
      }),
      declaration: contract.method.symbol,
      trait: traitSymbol,
      implementation: member.symbol,
      regions: Array.from(declaredRegions, (name) => ({
        name,
        parameter: 0,
        place: mappings.get(name)?.place,
      })),
      disjoint: verifiedDisjoint.map(([left, right]) => [left, right]),
      reads: contract.reads,
      mutates: contract.mutates,
      returnsFrom: contract.returnsFrom,
    });
  });
};

const namedContractScope = ({
  trait,
  name,
  moduleId,
  imports,
}: {
  trait: SymbolId;
  name: string;
  moduleId: string;
  imports: readonly {
    local: SymbolId;
    target?: { moduleId: string };
  }[];
}): string =>
  `${imports.find((entry) => entry.local === trait)?.target?.moduleId ?? moduleId}::${name}`;

const validateCallableSubset = ({
  callable,
  contract,
  mappings,
  declaration,
  span,
  diagnostics,
}: {
  callable: CallableBorrowContract;
  contract: DeclaredContract;
  mappings: ReadonlyMap<string, ResolvedRegion>;
  declaration: string;
  span: SourceSpan;
  diagnostics: BorrowingResult["diagnostics"][number][];
}): void => {
  const allowedReads = regionsFor(
    unique([...contract.reads, ...contract.mutates, ...contract.returnsFrom]),
    mappings,
  );
  const allowedWrites = regionsFor(contract.mutates, mappings);
  const allowedReturns = regionsFor(contract.returnsFrom, mappings);
  const receiver = callable.parameters[0];

  if (contract.hasBorrowedResult && callable.borrowedResult === "external") {
    requireCovered({
      path: [],
      allowed: [],
      clause: "returns_from",
      declaration,
      span,
      diagnostics,
      placeOverride: "<external provenance>",
    });
  }
  (receiver?.readPaths ?? []).forEach((path) =>
    requireCovered({
      path,
      allowed: allowedReads,
      clause: "reads",
      declaration,
      span,
      diagnostics,
    }),
  );
  callable.parameters.forEach((parameter, index) => {
    (parameter.writePaths ?? []).forEach((path) =>
      requireCovered({
        path,
        allowed: index === 0 ? allowedWrites : [],
        clause: "mutates",
        declaration,
        span,
        diagnostics,
        parameter: index,
      }),
    );
    returnedBorrowOriginsForContract({
      parameter,
      parameterIndex: index,
      contract,
    }).forEach((origin) =>
      requireCovered({
        path:
          origin.endpointAccess === "dereferenced" &&
          origin.source.at(-1)?.kind !== "dereference"
            ? [...origin.source, { kind: "dereference" }]
            : origin.source,
        allowed: index === 0 ? allowedReturns : [],
        clause: "returns_from",
        declaration,
        span,
        diagnostics,
        parameter: index,
      }),
    );
  });
};

const resolvedRegionsOverlap = (
  left: ResolvedRegion,
  right: ResolvedRegion,
  typing: TypingResult,
): boolean => {
  const sameStorage =
    left.storage.identity.kind === "receiver" &&
    right.storage.identity.kind === "receiver"
      ? true
      : left.storage.identity.kind === "dereference" &&
        right.storage.identity.kind === "dereference" &&
        projectionPathsEqual(
          left.storage.identity.source,
          right.storage.identity.source,
        );
  if (
    !sameStorage &&
    !left.storage.allocationTypes.some((leftType) =>
      right.storage.allocationTypes.some((rightType) =>
        allocationTypesMayAlias(leftType, rightType, typing),
      ),
    )
  ) {
    return false;
  }
  return projectionPathsOverlap(
    left.storage.relativePlace,
    right.storage.relativePlace,
  );
};

const allocationTypesMayAlias = (
  left: TypeId,
  right: TypeId,
  typing: TypingResult,
  active = new Set<string>(),
): boolean => {
  if (left === right) {
    return true;
  }
  const key = `${left}:${right}`;
  if (active.has(key)) {
    return false;
  }
  active.add(key);
  const leftDescriptor = typing.arena.get(left);
  const rightDescriptor = typing.arena.get(right);
  if (leftDescriptor.kind === "borrowed") {
    return allocationTypesMayAlias(leftDescriptor.inner, right, typing, active);
  }
  if (rightDescriptor.kind === "borrowed") {
    return allocationTypesMayAlias(left, rightDescriptor.inner, typing, active);
  }
  if (leftDescriptor.kind === "recursive") {
    return allocationTypesMayAlias(leftDescriptor.body, right, typing, active);
  }
  if (rightDescriptor.kind === "recursive") {
    return allocationTypesMayAlias(left, rightDescriptor.body, typing, active);
  }
  if (leftDescriptor.kind === "union") {
    return leftDescriptor.members.some((member) =>
      allocationTypesMayAlias(member, right, typing, new Set(active)),
    );
  }
  if (rightDescriptor.kind === "union") {
    return rightDescriptor.members.some((member) =>
      allocationTypesMayAlias(left, member, typing, new Set(active)),
    );
  }
  if (
    leftDescriptor.kind === "intersection" &&
    typeof leftDescriptor.nominal === "number"
  ) {
    return allocationTypesMayAlias(
      leftDescriptor.nominal,
      right,
      typing,
      active,
    );
  }
  if (
    rightDescriptor.kind === "intersection" &&
    typeof rightDescriptor.nominal === "number"
  ) {
    return allocationTypesMayAlias(
      left,
      rightDescriptor.nominal,
      typing,
      active,
    );
  }
  return false;
};

const returnedBorrowOriginsForContract = ({
  parameter,
  parameterIndex,
  contract,
}: {
  parameter: CallableBorrowContract["parameters"][number];
  parameterIndex: number;
  contract: DeclaredContract;
}) => {
  const origins = [
    ...(parameter.returnedSharedOrigins ?? []),
    ...(typeExprContainsBorrowed(
      contract.method.parameters[parameterIndex]?.type,
      undefined,
    )
      ? (parameter.returnedOrigins ?? [])
      : []),
  ];
  return Array.from(
    new Map(origins.map((origin) => [JSON.stringify(origin), origin])).values(),
  );
};

const requireCovered = ({
  path,
  allowed,
  clause,
  declaration,
  span,
  diagnostics,
  parameter = 0,
  placeOverride,
}: {
  path: readonly PlaceProjection[];
  allowed: readonly ResolvedRegion[];
  clause: "reads" | "mutates" | "returns_from";
  declaration: string;
  span: SourceSpan;
  diagnostics: BorrowingResult["diagnostics"][number][];
  parameter?: number;
  placeOverride?: string;
}): void => {
  if (
    parameter === 0 &&
    allowed.some(
      (region) =>
        projectionPathCovers(region.place, path) ||
        (clause === "returns_from" &&
          mappedAllocationCoversReturnedBorrow(region.place, path)) ||
        (clause === "reads" &&
          region.place.some(
            (projection, index) =>
              projection.kind === "dereference" &&
              projectionPathsEqual(path, region.place.slice(0, index)),
          )),
    )
  ) {
    return;
  }
  diagnostics.push(
    contractDiagnostic({
      kind: "contract-excess",
      declaration,
      clause,
      place: placeOverride
        ? placeOverride
        : parameter === 0
          ? formatPlace(path)
          : `parameter[${parameter}]${formatPlace(path).slice(4)}`,
      regions:
        allowed.length > 0
          ? allowed.map((region) => region.name).join(", ")
          : "<none>",
      span,
    }),
  );
};

const projectionPathsEqual = (
  left: readonly PlaceProjection[],
  right: readonly PlaceProjection[],
): boolean =>
  left.length === right.length &&
  left.every(
    (projection, index) =>
      JSON.stringify(projection) === JSON.stringify(right[index]),
  );

const resolveContractPlace = (
  place: HirContractPlace,
  targetType: TypeId,
  typing: TypingResult,
):
  | {
      ok: true;
      place: readonly PlaceProjection[];
      storage: ResolvedContractStorage;
    }
  | { ok: false; reason: string } => {
  let currentTypes: readonly TypeId[] = [targetType];
  let endpoint: "storage" | "slot" = "storage";
  let storage: ResolvedContractStorage = {
    identity: { kind: "receiver" },
    allocationTypes: [targetType],
    relativePlace: [],
  };
  const resolved: PlaceProjection[] = [];
  for (const projection of place.projections) {
    if (projection.kind === "dereference") {
      if (
        endpoint !== "slot" ||
        currentTypes.length === 0 ||
        !currentTypes.every((type) =>
          typeIsDefinitelyAllocationBacked(type, typing),
        )
      ) {
        return {
          ok: false,
          reason:
            "deref(...) requires a definitely allocation-backed handle slot",
        };
      }
      resolved.push({ kind: "dereference" });
      storage = {
        identity: {
          kind: "dereference",
          source: [...resolved],
        },
        allocationTypes: currentTypes,
        relativePlace: [],
      };
      endpoint = "storage";
      continue;
    }
    const semanticProjection: PlaceProjection =
      projection.kind === "index"
        ? {
            kind: "index",
            constant: projection.constant,
            stable: true,
          }
        : projection;
    const projected = currentTypes.map((type) =>
      projectContractType({
        type,
        projection: semanticProjection,
        endpoint,
        typing,
      }),
    );
    const invalid = projected.find((entry) => !entry.ok);
    if (invalid && !invalid.ok) {
      return {
        ok: false,
        reason: invalid.reason,
      };
    }
    resolved.push(semanticProjection);
    storage = {
      ...storage,
      relativePlace: [...storage.relativePlace, semanticProjection],
    };
    currentTypes = uniqueNumbers(
      projected.flatMap((entry) => (entry.ok ? entry.types : [])),
    );
    endpoint = "slot";
  }
  return { ok: true, place: resolved, storage };
};

export const namedRegionPlacePath = (
  place: HirContractPlace,
): readonly PlaceProjection[] =>
  place.projections.map((projection) =>
    projection.kind === "index"
      ? {
          kind: "index" as const,
          constant: projection.constant,
          stable: true,
        }
      : projection,
  );

const projectContractType = ({
  type,
  projection,
  endpoint,
  typing,
  active = new Set<TypeId>(),
}: {
  type: TypeId;
  projection: PlaceProjection;
  endpoint: "storage" | "slot";
  typing: TypingResult;
  active?: Set<TypeId>;
}): { ok: true; types: readonly TypeId[] } | { ok: false; reason: string } => {
  if (active.has(type)) {
    return {
      ok: false,
      reason: `projection '${formatProjection(projection)}' cannot be resolved through a recursive contract place`,
    };
  }
  active.add(type);
  const descriptor = typing.arena.get(type);
  if (descriptor.kind === "recursive") {
    return projectContractType({
      type: typing.arena.unfoldRecursive(type),
      projection,
      endpoint,
      typing,
      active,
    });
  }
  if (descriptor.kind === "borrowed") {
    if (endpoint === "slot") {
      return explicitDereferenceRequired(projection);
    }
    return projectContractType({
      type: descriptor.inner,
      projection,
      endpoint,
      typing,
      active,
    });
  }
  if (descriptor.kind === "union") {
    const members = descriptor.members.map((member) =>
      projectContractType({
        type: member,
        projection,
        endpoint,
        typing,
        active: new Set(active),
      }),
    );
    const invalid = members.find((member) => !member.ok);
    if (invalid && !invalid.ok) {
      return {
        ok: false,
        reason: `projection '${formatProjection(projection)}' must exist on every possible mapped type: ${invalid.reason}`,
      };
    }
    return {
      ok: true,
      types: uniqueNumbers(
        members.flatMap((member) => (member.ok ? member.types : [])),
      ),
    };
  }
  if (descriptor.kind === "intersection") {
    if (
      endpoint === "slot" &&
      typeof descriptor.nominal === "number" &&
      typeIsDefinitelyAllocationBacked(descriptor.nominal, typing)
    ) {
      return explicitDereferenceRequired(projection);
    }
    const components = [descriptor.nominal, descriptor.structural].flatMap(
      (component) => (typeof component === "number" ? [component] : []),
    );
    const projected = components.map((component) =>
      projectContractType({
        type: component,
        projection,
        endpoint,
        typing,
        active: new Set(active),
      }),
    );
    const valid = projected.filter(
      (
        result,
      ): result is {
        ok: true;
        types: readonly TypeId[];
      } => result.ok,
    );
    return valid.length > 0
      ? {
          ok: true,
          types: uniqueNumbers(valid.flatMap((result) => result.types)),
        }
      : missingContractProjection(projection);
  }
  if (
    endpoint === "slot" &&
    (descriptor.kind === "nominal-object" ||
      descriptor.kind === "fixed-array" ||
      descriptor.kind === "function" ||
      descriptor.kind === "trait")
  ) {
    return explicitDereferenceRequired(projection);
  }
  if (projection.kind === "index" && descriptor.kind === "fixed-array") {
    return { ok: true, types: [descriptor.element] };
  }
  const fields =
    descriptor.kind === "structural-object"
      ? descriptor.fields
      : descriptor.kind === "nominal-object" ||
          descriptor.kind === "value-object"
        ? typing.objectsByNominal.get(type)?.fields
        : undefined;
  const field =
    projection.kind === "field"
      ? fields?.find((candidate) => candidate.name === projection.name)
      : projection.kind === "tuple"
        ? fields?.[projection.index]
        : undefined;
  return field
    ? { ok: true, types: [field.type] }
    : missingContractProjection(projection);
};

const explicitDereferenceRequired = (
  projection: PlaceProjection,
): { ok: false; reason: string } => ({
  ok: false,
  reason: `projection '${formatProjection(projection)}' crosses a handle slot; use explicit deref(...)`,
});

const missingContractProjection = (
  projection: PlaceProjection,
): { ok: false; reason: string } => ({
  ok: false,
  reason: `projection '${formatProjection(projection)}' does not exist on the mapped type`,
});

const regionsFor = (
  names: readonly string[],
  mappings: ReadonlyMap<string, ResolvedRegion>,
): readonly ResolvedRegion[] =>
  names.flatMap((name) => {
    const mapping = mappings.get(name);
    return mapping ? [mapping] : [];
  });

const disjointPairs = (
  declarations: readonly {
    regions: readonly string[];
    span: SourceSpan;
  }[],
): readonly (readonly [string, string, SourceSpan])[] =>
  declarations.flatMap((declaration) =>
    declaration.regions.flatMap((left, leftIndex) =>
      declaration.regions
        .slice(leftIndex + 1)
        .map((right) => [left, right, declaration.span] as const),
    ),
  );

const unique = (values: readonly string[]): readonly string[] =>
  Array.from(new Set(values));

const uniqueNumbers = (values: readonly number[]): readonly number[] =>
  Array.from(new Set(values));

const borrowedPathsInTypeExpression = (
  expression: HirTypeExpr | undefined,
  typing: TypingResult,
  prefix: readonly PlaceProjection[] = [],
  substitutions: ReadonlyMap<SymbolId, HirTypeExpr> = new Map(),
  active = new Set<SymbolId>(),
): readonly (readonly PlaceProjection[])[] => {
  if (!expression) {
    return [];
  }
  const resolved = declaredTypeId(expression, typing);
  const resolvedPaths =
    typeof resolved === "number"
      ? borrowedPathsInType(resolved, typing).map((path) => [
          ...prefix,
          ...path,
        ])
      : [];
  if (resolvedPaths.length > 0) {
    return resolvedPaths;
  }
  if (expression.typeKind === "borrowed") {
    return [
      prefix,
      ...borrowedPathsInTypeExpression(
        expression.inner,
        typing,
        prefix,
        substitutions,
        active,
      ),
    ];
  }
  if (
    expression.typeKind === "named" &&
    typeof expression.symbol === "number"
  ) {
    const substitution = substitutions.get(expression.symbol);
    if (substitution) {
      return borrowedPathsInTypeExpression(
        substitution,
        typing,
        prefix,
        substitutions,
        active,
      );
    }
    if (active.has(expression.symbol)) {
      return [];
    }
    const nextActive = new Set(active).add(expression.symbol);
    const object = typing.objects.getDecl(expression.symbol);
    if (object) {
      const nextSubstitutions = new Map(substitutions);
      object.typeParameters?.forEach((parameter, index) => {
        const argument = expression.typeArguments?.[index];
        if (argument) {
          nextSubstitutions.set(parameter.symbol, argument);
        }
      });
      return object.fields.flatMap((field) =>
        borrowedPathsInTypeExpression(
          field.type,
          typing,
          [...prefix, { kind: "field", name: field.name }],
          nextSubstitutions,
          nextActive,
        ),
      );
    }
    const alias = typing.typeAliases.getTemplate(expression.symbol);
    const aliasPaths = alias
      ? (() => {
          const nextSubstitutions = new Map(substitutions);
          alias.params.forEach((parameter, index) => {
            const argument = expression.typeArguments?.[index];
            if (argument) {
              nextSubstitutions.set(parameter.symbol, argument);
            }
          });
          return borrowedPathsInTypeExpression(
            alias.target,
            typing,
            prefix,
            nextSubstitutions,
            nextActive,
          );
        })()
      : [];
    if (aliasPaths.length > 0) {
      return aliasPaths;
    }
    const borrowedTypeArguments = expression.typeArguments?.flatMap(
      (argument) =>
        borrowedPathsInTypeExpression(
          argument,
          typing,
          prefix,
          substitutions,
          nextActive,
        ),
    );
    return borrowedTypeArguments?.length ? [prefix] : [];
  }
  if (expression.typeKind === "object") {
    return expression.fields.flatMap((field) =>
      borrowedPathsInTypeExpression(
        field.type,
        typing,
        [...prefix, { kind: "field", name: field.name }],
        substitutions,
        active,
      ),
    );
  }
  if (expression.typeKind === "tuple") {
    return expression.elements.flatMap((element, index) =>
      borrowedPathsInTypeExpression(
        element,
        typing,
        [...prefix, { kind: "tuple", index }],
        substitutions,
        active,
      ),
    );
  }
  if (
    expression.typeKind === "union" ||
    expression.typeKind === "intersection"
  ) {
    return expression.members.flatMap((member) =>
      borrowedPathsInTypeExpression(
        member,
        typing,
        prefix,
        substitutions,
        new Set(active),
      ),
    );
  }
  return [];
};

const typeExprContainsBorrowed = (
  expression: HirTypeExpr | undefined,
  typing?: TypingResult,
): boolean => {
  if (!expression) {
    return false;
  }
  if (
    typing !== undefined &&
    borrowedPathsInTypeExpression(expression, typing).length > 0
  ) {
    return true;
  }
  const resolved =
    typing === undefined ? undefined : declaredTypeId(expression, typing);
  if (
    typing !== undefined &&
    typeof resolved === "number" &&
    typeContainsBorrowed(resolved, typing)
  ) {
    return true;
  }
  const contains = (child: HirTypeExpr | undefined): boolean =>
    typeExprContainsBorrowed(child, typing);
  switch (expression.typeKind) {
    case "borrowed":
      return true;
    case "named":
      return expression.typeArguments?.some(contains) ?? false;
    case "object":
      return expression.fields.some((field) => contains(field.type));
    case "tuple":
      return expression.elements.some(contains);
    case "union":
    case "intersection":
      return expression.members.some(contains);
    case "function":
      return contains(expression.returnType);
    case "self":
      return false;
  }
};

const declaredTypeId = (
  expression: HirTypeExpr | undefined,
  typing: TypingResult,
  active = new Set<SymbolId>(),
): TypeId | undefined => {
  if (!expression) {
    return undefined;
  }
  if (typeof expression.typeId === "number") {
    return expression.typeId;
  }
  if (expression.typeKind === "borrowed") {
    const inner = declaredTypeId(expression.inner, typing, active);
    return typeof inner === "number"
      ? typing.arena.internBorrowed(inner)
      : undefined;
  }
  if (expression.typeKind === "union") {
    const members = expression.members.map((member) =>
      declaredTypeId(member, typing, new Set(active)),
    );
    return members.every(
      (member): member is TypeId => typeof member === "number",
    )
      ? typing.arena.internUnion(members)
      : undefined;
  }
  if (
    expression.typeKind !== "named" ||
    typeof expression.symbol !== "number" ||
    active.has(expression.symbol)
  ) {
    return undefined;
  }
  const object = typing.objects.getTemplate(expression.symbol)?.type;
  if (typeof object === "number") {
    return object;
  }
  const intrinsic = typing.intrinsicTypes.get(expression.path.at(-1) ?? "");
  if (typeof intrinsic === "number") {
    return intrinsic;
  }
  const alias = typing.typeAliases.getTemplate(expression.symbol);
  return alias
    ? declaredTypeId(
        alias.target,
        typing,
        new Set(active).add(expression.symbol),
      )
    : undefined;
};

const formatPlace = (path: readonly PlaceProjection[]): string =>
  path.reduce((display, projection) => {
    switch (projection.kind) {
      case "field":
        return `${display}.${projection.name}`;
      case "tuple":
        return `${display}.${projection.index}`;
      case "index":
        return `${display}[${projection.constant ?? "?"}]`;
      case "dereference":
        return `deref(${display})`;
      case "discriminant":
        return `${display}.<discriminant>`;
      case "identity":
        return `${display}.<identity>`;
      case "region":
        return `${display}.<region ${projection.name}>`;
    }
  }, "self");

const formatProjection = (projection: PlaceProjection): string => {
  switch (projection.kind) {
    case "field":
      return projection.name;
    case "tuple":
      return String(projection.index);
    case "index":
      return `[${projection.constant ?? "?"}]`;
    case "dereference":
      return "deref";
    case "discriminant":
      return "discriminant";
    case "identity":
      return "identity";
    case "region":
      return `region ${projection.name}`;
  }
};

const contractDiagnostic = (
  params: DiagnosticParams<"TY0054"> & { span: SourceSpan },
): BorrowingResult["diagnostics"][number] => {
  const { span, ...diagnosticParams } = params;
  return diagnosticFromCode({
    code: "TY0054",
    params: diagnosticParams,
    span,
  });
};
