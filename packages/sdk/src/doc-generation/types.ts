export type DocumentationOutputFormat = "html" | "json";

export type DocumentationParameter = {
  name: string;
  documentation: string;
};

export type DocumentationMember = {
  name: string;
  signature: string;
  documentation?: string;
  anchor: string;
};

export type DocumentationItemKind =
  | "re_export"
  | "macro"
  | "module_let"
  | "function"
  | "type_alias"
  | "object"
  | "trait"
  | "effect"
  | "impl";

export type DocumentationItem = {
  kind: DocumentationItemKind;
  name: string;
  fqn: string;
  targetName?: string;
  signature: string;
  documentation?: string;
  anchor: string;
  parameterDocs: readonly DocumentationParameter[];
  members: readonly DocumentationMember[];
};

export type ModuleDocumentationSection = {
  id: string;
  depth: number;
  anchor: string;
  documentation?: string;
  macros: readonly DocumentationItem[];
  reexports: readonly DocumentationItem[];
  moduleLets: readonly DocumentationItem[];
  functions: readonly DocumentationItem[];
  typeAliases: readonly DocumentationItem[];
  objects: readonly DocumentationItem[];
  traits: readonly DocumentationItem[];
  effects: readonly DocumentationItem[];
  impls: readonly DocumentationItem[];
};

export type DocumentationModel = {
  entryModule: string;
  generatedAt: string;
  modules: readonly ModuleDocumentationSection[];
};
