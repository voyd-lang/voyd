# Compiler Surface Syntax Boundary

Voyd's parser produces generic syntax forms because reader and functional macros
must be able to create syntax without depending on semantics. Generic forms are
not, however, a suitable contract for binding or HIR lowering. The
`packages/compiler/src/parser/surface` package owns the structural interpretation
between those layers.

## Products

`ModuleHeaderView` is built from base-expanded syntax. It contains only the
module items needed before functional macro expansion: uses and exports, inline
modules, external module declarations, and macro declarations. Module discovery
and macro import ordering consume this view.

`SurfaceModuleView` is built after functional and post-syntax macro expansion.
It contains normalized declarations and their signatures, parameters, fields,
impl methods, and effect operations. It also carries structural syntax issues.
The binder consumes this view rather than classifying top-level `Form` objects.

Both views reference the original syntax nodes and syntax IDs. They do not clone
the AST or introduce a second source-location identity.

Module consumers use phase-checking accessors rather than rebuilding a missing
view from mutable `module.ast`. A missing header after graph construction or a
missing surface after expansion is an invariant failure. The standalone
semantics entry point is the sole initializer allowed to materialize and attach
an expanded surface for a caller-supplied module.

Expression-level normalizers are parser-owned, syntax-identity-cached accessors.
Binding and lowering may request the same normalized lambda, binding, match,
pattern, brace-entry, try/handler, or control-flow shape without either phase
reparsing the generic form. Keeping these products keyed by the original syntax
object avoids inflating `SurfaceModuleView` while retaining a single structural
owner.

One narrow exception is an ambiguous parser association that cannot represent a
complete nested type directly (for example, a parameter whose type is itself a
function type). Its accessor may cache a reconstructed subform, but must reuse
the source operator and preserve the enclosing annotation's exact location.
Consumers treat the original annotation as the source owner; reconstruction is
never repeated downstream.

`classifySurfaceForm` is the shared structural classifier for call-like and
clause-owning forms. Expression validation and ambiguous brace-marker handling
must extend that classifier when a new special form is introduced instead of
maintaining independent head-name allowlists.

## Ownership rule

The surface layer owns validation that can be decided from syntax and lexical
context alone, including declaration shape, modifiers, parameter groups,
defaults, object and record entries, patterns, and control-flow clauses.

Semantics continues to own decisions requiring symbols or types: name and module
resolution, visibility access, overload selection, trait conformance, effect
operation identity, constructor availability, and type/effect checking. For
ambiguous constructs such as bare effect-handler heads, the surface layer may
normalize the head and body shape, but semantic resolution determines meaning.

When the reader must retain lexical context that generic forms cannot express,
it emits an explicit surface marker rather than out-of-band mutable state. For
example, brace reading marks an ambiguous second same-line field label; the
brace-entry normalizer then resolves that marker against complete expression
structure. The marker is absent from valid normalized syntax and never becomes
a semantic contract.

Downstream code may inspect source syntax for spans and identity. It should not
reparse generic forms to decide whether user-written syntax is structurally
valid. New syntax forms should add or extend a parser-surface representation and
then update semantic consumers of that representation.

## Diagnostics

Reader and base-syntax validation reject malformed token relationships before
macro expansion. Expanded module normalization reports declaration-level syntax
issues through the module graph, so malformed user source cannot reach binding
or lowering as an internal invariant failure. Parser-only APIs may continue to
throw `ParserSyntaxError`; compiler entry points convert those errors to normal
diagnostics at the module boundary.
