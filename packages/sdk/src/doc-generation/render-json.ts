import type { DocumentationModel } from "./types.js";

export const renderDocumentationJson = ({
  model,
}: {
  model: DocumentationModel;
}): string => `${JSON.stringify(model, null, 2)}\n`;
