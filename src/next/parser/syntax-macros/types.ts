import { Form } from "../ast/form.js";

/** Takes the whole ast, returns a transformed version of the whole ast */
export type SyntaxMacro = (form: Form) => Form;
