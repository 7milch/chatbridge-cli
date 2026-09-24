; Vendored from https://github.com/tree-sitter/tree-sitter-json at v0.20.2 (queries/highlights.scm), MIT.
; The wasm next to it is tree-sitter-wasms@0.1.13's build of the same grammar version.
(pair
  key: (_) @string.special.key)

(string) @string

(number) @number

[
  (null)
  (true)
  (false)
] @constant.builtin

(escape_sequence) @escape

(comment) @comment
