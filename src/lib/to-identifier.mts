export const toIdentifier = (str: string): string => {
  return str.replace(/\'/g, "");
};
