# tree-sitter-teal
Tree-sitter grammar definition for TEAL (Transaction Execution Approval Language), the Algorand Virtual Machine domain specific language.

Supports AVM v1 through v13, plus the assembler's pseudo-ops (`int`/`byte`/`addr`/`method`,
named `int` constants, the `txn`/`itxn`/`gitxn` array sugar, bare `extract`/`replace`),
template variables (`TMPL_*`) and the label spellings real compilers emit (Puya `@`,
TEALScript `*`, puya-sol paths, puya-ts `::`).

## Layout

- `grammar.js` — the grammar. It decides instruction *shapes* only; every opcode and field
  name comes from `vocab/avm.json`, and generation fails if a spec opcode has no rule.
- `vocab/avm.json` — generated from the official go-algorand langspec at a pinned commit
  (see its `spec` key) by `scripts/gen_vocab.js`. Do not edit by hand.
- `test/corpus/` — `tree-sitter test` cases.
- `scripts/check_spec.js` — parses every opcode × every field of the pinned spec and fails
  on any line that does not come back as one clean instruction node.

## Updating

```sh
node scripts/gen_vocab.js        # only when moving to a new langspec (edit SPEC in the script first)
tree-sitter generate             # regenerate src/parser.c, src/grammar.json, src/node-types.json
tree-sitter test
node scripts/check_spec.js
```

Every other file is just bindings into the generated parser.

## Node types consumers rely on

One top-level node per instruction (`*_opcode`), `label` (a single token, including its
colon), `comment`, `pragma_*`. An instruction never spans more than its own line: newlines
are significant, and a `;` separates instructions on one line. A mnemonic the grammar does
not know becomes an explicit `unknown_opcode` node rather than an `ERROR` that swallows the
next line.
