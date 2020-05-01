import { ExpressionRef } from "binaryen";

declare module "binaryen" {
    interface Module {
        tuple: {
            make(elements: ExportRef[]): ExpressionRef;
            extract(tuple: ExpressionRef, index: number): ExpressionRef;
        }
    }
}
