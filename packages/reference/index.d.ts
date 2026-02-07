export type ReferenceDoc = {
  slug: string;
  title: string;
  body: string;
};

export declare const referenceDocs: Record<string, ReferenceDoc>;
export declare const referenceNav: Array<Pick<ReferenceDoc, "slug" | "title">>;
export declare function getReferenceDoc(slug: string): ReferenceDoc | null;
declare const _default: typeof referenceNav;
export default _default;
