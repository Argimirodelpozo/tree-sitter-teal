/**
 * @file Tree sitter parser for the TEAL DSL (Algorand Virtual Machine assembly language)
 * @author Argimiro del Pozo
 * @license MIT
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

// ---------------------------------------------------------------------------
// Vocabulary
//
// Every opcode and field name comes from vocab/avm.json, which
// scripts/gen_vocab.js generates from the official go-algorand langspec (pinned
// commit + sha256). Nothing below re-lists an opcode or field by hand: the rules
// only decide the SHAPE of each instruction (which node type, which immediates).
// `partition()` refuses to generate a grammar that leaves a spec opcode without
// a rule, so a new AVM version cannot be silently half-supported.
// ---------------------------------------------------------------------------

const VOCAB = require("./vocab/avm.json");
const OPS = VOCAB.ops;

/** Field names of `op`'s field immediate, in spec order. */
const fieldsOf = (...ops) => [...new Set(ops.flatMap((op) => {
  if (!OPS[op] || !OPS[op].fields) throw new Error(`vocab: ${op} has no fields`);
  return OPS[op].fields.map((f) => f.name);
}))];

const immediatesOf = (op) => OPS[op].immediates;

/** `choice` over a vocabulary list (a one-name list is the name itself). */
const oneOf = (names) => (names.length === 1 ? names[0] : choice(...names));
const isNumericImm = (imm) => !imm.reference && /^(u?int8|varuint)$/.test(imm.encoding);
const isTargetImm = (imm) => imm.name.startsWith("TARGET");

// Field groups. `txn` lists array fields too (`txn ApplicationArgs 0` is the
// assembler's txna sugar), so the scalar set is txn minus txna.
const TXN_ARRAY_FIELDS = fieldsOf("txna");
const TXN_FIELDS = fieldsOf("txn").filter((f) => !TXN_ARRAY_FIELDS.includes(f));
const GLOBAL_FIELDS = fieldsOf("global");
const BLOCK_FIELDS = fieldsOf("block");
const ASSET_HOLDING_FIELDS = fieldsOf("asset_holding_get");
const ASSET_PARAMS = fieldsOf("asset_params_get");
const APP_PARAMS = fieldsOf("app_params_get");
const APP_PARAMS_SET = fieldsOf("app_params_set");
const ACCOUNT_PARAMS = fieldsOf("acct_params_get");
const VOTER_PARAMS = fieldsOf("voter_params_get");
const ECDSA_OPS = ["ecdsa_verify", "ecdsa_pk_decompress", "ecdsa_pk_recover"];
const EC_OPS = ["ec_add", "ec_scalar_mul", "ec_pairing_check",
  "ec_multi_scalar_mul", "ec_subgroup_check", "ec_map_to"];

// Opcodes with a dedicated rule (shape not derivable from the immediate list
// alone, or kept as its own node type for compatibility).
const DEDICATED = new Set([
  "intc", "load", "store",
  "intcblock", "bytecblock", "pushbytes", "pushbytess", "pushints",
  "b", "bz", "bnz", "callsub", "match", "switch",
  ...ECDSA_OPS, ...EC_OPS, "mimc", "poseidon2", "vrf_verify",
  "asset_holding_get", "asset_params_get", "app_params_get", "app_params_set",
  "acct_params_get", "voter_params_get", "base64_decode", "json_ref",
  "txn", "txna", "txnas", "itxn", "itxn_field", "itxna", "itxnas",
  "gitxn", "gitxna", "gitxnas", "gtxn", "gtxna", "gtxnas", "gtxns", "gtxnsa", "gtxnsas",
  "global", "block",
]);

/** Split the spec opcodes into the generic shape buckets; throw on any leftover. */
function partition() {
  const zero = [], single = [], double = [], leftover = [];
  for (const [name, op] of Object.entries(OPS)) {
    if (DEDICATED.has(name)) continue;
    const imms = op.immediates;
    if (imms.length === 0) zero.push(name);
    else if (imms.length === 1 && isNumericImm(imms[0])) single.push(name);
    else if (imms.length === 2 && imms.every(isNumericImm)) double.push(name);
    else leftover.push(name);
  }
  for (const name of DEDICATED) {
    if (!OPS[name]) leftover.push(`${name} (dedicated rule, but not in the spec)`);
  }
  if (leftover.length) {
    throw new Error(`grammar.js: no rule for spec opcode(s): ${leftover.join(", ")}`);
  }
  for (const name of ["b", "bz", "bnz", "callsub", "match", "switch"]) {
    if (!immediatesOf(name).every(isTargetImm)) throw new Error(`${name} is not a branch`);
  }
  return { zero, single, double };
}

const SHAPES = partition();

const ZERO_ARGUMENT_OPCODES = [
  ...SHAPES.zero,
  // Assembler pseudo-op forms with no immediates: `extract` == extract3,
  // `replace` == replace3.
  "extract", "replace",
];

const SINGLE_NUMERIC_ARGUMENT_OPCODES = [
  ...SHAPES.single,
  // `replace N` is the assembler's spelling of replace2.
  "replace",
];

const DOUBLE_NUMERIC_ARGUMENT_OPCODES = SHAPES.double;

const NAMED_INT_CONSTANTS = Object.keys(VOCAB.named_int_constants);

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

// Integers as the assembler reads them (strconv.ParseUint(s, 0, 64)): decimal,
// 0x hex, 0o / leading-0 octal, 0b binary, `_` digit separators.
const NUMBER = /-?(0[xX][0-9A-Fa-f_]+|0[oO][0-7_]+|0[bB][01_]+|[0-9][0-9_]*)/;
// A string literal, tokenized as go-algorand's assembler does (tokensFromLine):
// - it closes at the first quote NOT immediately preceded by a backslash, so it
//   never runs on into a later quote inside a trailing comment;
// - a quote after a backslash -- even an escaped one, as in "a\\" -- does not
//   close it, and a literal left open that way ends at that backslash-quote;
// - after the closing quote the TOKEN continues up to the next separator
//   (`"a\\" "b"` is one token), except that a glued `//` starts a comment.
const STRING_BODY = /([^"\\\r\n]|\\+([^"\\\r\n]|"))*/.source;
const STRING_TAIL = /([^\s;\/]|\/[^\/\s;])*/.source;
const STRING = new RegExp(`"${STRING_BODY}("${STRING_TAIL}|\\\\+")`);
const HEX_BYTES = /0x[A-Fa-f0-9]*/;

// Label names: what compilers actually emit -- `main_route@5` (Puya),
// `*addStake*return` (TEALScript), `/path/Token.sol.transfer` (puya-sol),
// `contract.algo.ts::Main.method` (puya-ts), `a[0]`, `a.b-c`. A name may start
// with `/` only if the next character is not `/` (that is a comment).
const LABEL_START = "(\\/[^\\/\\s;\"]|[A-Za-z_*.$@\\[\\]])";
const LABEL_REST = "[^\\s;\"]*";

module.exports = grammar({
  name: "teal",

  // Newlines are NOT extras: one instruction ends at the end of its line (or at
  // `;`), so a missing immediate can never swallow the next line.
  extras: ($) => [
    $.comment,
    /[ \t\f\v\r﻿⁠​ ]/,
  ],

  // The word token allows tree-sitter to appropriately handle scenario's where an identifier includes a keyword.
  // Documentation: https://tree-sitter.github.io/tree-sitter/creating-parsers#keywords
  word: ($) => $.label_identifier,

  rules: {
    //  -- [ Contract ] --
    source: ($) => seq(
      repeat(choice($._newline, seq($._line, $._newline))),
      optional($._line),
    ),

    _line: ($) => choice(
      seq($.label, optional($._statements)),
      $._statements,
    ),

    _statements: ($) => seq(
      $._expression,
      repeat(seq($._semicolon, $._expression)),
      optional($._semicolon),
    ),

    _newline: (_) => /\n/,
    _semicolon: (_) => ";",

    _expression: $ => choice(
      $.pragma_version,
      $.pragma_typetrack,

      //Generic rules to catch most cases
      $.zero_argument_opcode,
      $.single_numeric_argument_opcode,
      $.intc_opcode,
      $.load_opcode,
      $.store_opcode,
      $.double_numeric_argument_opcode,

      //Branching instructions
      $.b_opcode,
      $.bz_opcode,
      $.bnz_opcode,
      $.callsub_opcode,
      $.match_opcode,
      $.switch_opcode,

      $.ecdsa_opcode,
      $.ec_opcode,
      $.mimc_opcode,
      $.poseidon2_opcode,
      $.vrf_verify_opcode,

      $.asset_holding_get_opcode,
      $.asset_params_get_opcode,
      $.app_params_get_opcode,
      $.app_params_set_opcode,
      $.acct_params_get_opcode,
      $.voter_params_get_opcode,

      $.base64_decode_opcode,
      $.json_ref_opcode,

      $.intcblock_opcode,
      $.bytecblock_opcode,
      $.pushbytess_opcode,
      $.pushints_opcode,
      $.pushbytes_opcode,

      // Assembler pseudo-ops
      $.byte_pseudo_opcode,
      $.addr_pseudo_opcode,
      $.method_pseudo_opcode,

      //Txn stuff (current, group, inner, and variants)
      $.txn_opcode,
      $.txna_opcode,
      $.txnas_opcode,
      $.itxn_opcode,
      $.itxn_field_opcode,
      $.itxna_opcode,
      $.itxnas_opcode,
      $.gitxnas_opcode,
      $.gitxn_opcode,
      $.gitxna_opcode,
      $.gtxns_opcode,
      $.gtxnsa_opcode,
      $.gtxnas_opcode,
      $.gtxnsas_opcode,
      $.gtxn_opcode,
      $.gtxna_opcode,

      $.global_opcode,
      $.block_opcode,

      // Anything else that looks like an instruction: a mnemonic this grammar
      // does not know. Kept as an explicit node (never a bare identifier or a
      // phantom label) so consumers can report it.
      $.unknown_opcode,
    ),

    numeric_argument: (_) => NUMBER,
    string_argument: (_) => STRING,
    hexbytes_argument: (_) => token(prec(1, HEX_BYTES)),
    // `base64(...)`, `b64(...)`, `base64 X`, `b64 X` and the base32 forms. One
    // token, because the payload may contain `//`, which is not a comment there.
    base64_argument: (_) => token(prec(1, choice(
      seq(choice("base64", "b64"), "(", /[A-Za-z0-9+\/=]*/, ")"),
      seq(choice("base64", "b64"), /[ \t]+/, /[A-Za-z0-9+\/=]+/),
    ))),
    base32_argument: (_) => token(prec(1, choice(
      seq(choice("base32", "b32"), "(", /[A-Za-z2-7=]*/, ")"),
      seq(choice("base32", "b32"), /[ \t]+/, /[A-Za-z2-7=]+/),
    ))),
    // A deployment template variable (`TMPL_FEE`, `PRFX_ADMIN`): ALL-CAPS
    // PREFIX_NAME, substituted before assembly, so it has no value here.
    template_variable: (_) => token(prec(1, /[A-Z][A-Z0-9]*_[A-Z0-9_]+/)),
    // `int pay`, `int DeleteApplication`, ...
    named_integer_constant: (_) => oneOf(NAMED_INT_CONSTANTS),
    address_argument: (_) => token(prec(1, /[A-Z2-7]{58}/)),

    _txn_field: $ => oneOf(TXN_FIELDS),
    _txna_field: $ => oneOf(TXN_ARRAY_FIELDS),
    _global_field: $ => oneOf(GLOBAL_FIELDS),
    _block_field: $ => oneOf(BLOCK_FIELDS),

    _byte_value: $ => choice(
      $.string_argument, $.hexbytes_argument, $.base64_argument, $.base32_argument,
    ),

    // A comment runs to the end of the line -- TEAL has no line continuation,
    // so a trailing backslash does not extend it.
    comment: (_) => token(seq("//", /[^\r\n]*/)),

    // TEAL pragmas for AVM version (e.g., #pragma version 6)
    pragma_version: $ => seq(
      "#pragma",
      "version",
      field("version", NUMBER)
    ),

    // TEAL pragmas for typechecking (e.g., #pragma typechecking false)
    pragma_typetrack: $ => seq(
      "#pragma",
      "typetrack",
      choice("true", "false")
    ),

    // A branch target / label reference.
    label_identifier: (_) => new RegExp(LABEL_START + LABEL_REST),

    // A label definition is ONE token including its colon, so `pop:` /
    // `concat:` / `b:` (labels named like opcodes) are labels by longest match,
    // and `a::b:` keeps its inner `::`.
    label: (_) => token(prec(2, new RegExp(LABEL_START + LABEL_REST + ":"))),

    zero_argument_opcode: $ => oneOf(ZERO_ARGUMENT_OPCODES),

    ecdsa_opcode: $ => seq(
      field("op", oneOf(ECDSA_OPS)),
      oneOf(fieldsOf(...ECDSA_OPS))
    ),

    ec_opcode: $ => seq(
      field("op", oneOf(EC_OPS)),
      oneOf(fieldsOf(...EC_OPS))
    ),

    mimc_opcode: $ => seq(
      "mimc",
      oneOf(fieldsOf("mimc"))
    ),

    poseidon2_opcode: $ => seq(
      "poseidon2",
      oneOf(fieldsOf("poseidon2"))
    ),

    asset_holding_get_opcode: $ => seq(
      "asset_holding_get",
      oneOf(ASSET_HOLDING_FIELDS)
    ),

    asset_params_get_opcode: $ => seq(
      "asset_params_get",
      oneOf(ASSET_PARAMS),
    ),

    app_params_get_opcode: $ => seq(
      "app_params_get",
      oneOf(APP_PARAMS)
    ),

    app_params_set_opcode: $ => seq(
      "app_params_set",
      oneOf(APP_PARAMS_SET)
    ),

    acct_params_get_opcode: $ => seq(
      "acct_params_get",
      oneOf(ACCOUNT_PARAMS)
    ),

    voter_params_get_opcode: $ => seq(
      "voter_params_get",
      oneOf(VOTER_PARAMS)
    ),

    base64_decode_opcode: $ => seq(
      "base64_decode",
      oneOf(fieldsOf("base64_decode"))
    ),

    json_ref_opcode: $ => seq(
      "json_ref",
      oneOf(fieldsOf("json_ref"))
    ),

    vrf_verify_opcode: $ => seq(
      "vrf_verify",
      oneOf(fieldsOf("vrf_verify"))
    ),

    intcblock_opcode: $ => seq(
      "intcblock",
      field("value", repeat(choice($.numeric_argument, $.template_variable))),
    ),

    bytecblock_opcode: $ => seq(
      "bytecblock",
      repeat(choice($.numeric_argument, $._byte_value, $.template_variable))
    ),

    pushbytess_opcode: $ => seq(
      "pushbytess",
      repeat(choice($.numeric_argument, $._byte_value, $.template_variable))
    ),

    byte_pseudo_opcode: $ => seq(
      "byte",
      repeat1(choice($.numeric_argument, $._byte_value, $.template_variable))
    ),

    addr_pseudo_opcode: $ => seq(
      "addr",
      field("value", choice($.address_argument, $.template_variable))
    ),

    method_pseudo_opcode: $ => seq(
      "method",
      field("value", $.string_argument)
    ),

    single_numeric_argument_opcode: $ => choice(
      seq(
        field("op", oneOf(SINGLE_NUMERIC_ARGUMENT_OPCODES)),
        field("value", $.numeric_argument)
      ),
      seq(
        field("op", "pushint"),
        field("value", $.template_variable)
      ),
      //pseudo-opcode but included for completeness
      seq(
        field("op", "int"),
        field("value", choice($.numeric_argument, $.template_variable, $.named_integer_constant))
      ),
    ),

    intc_opcode: $ => seq(
      "intc",
      field("value", $.numeric_argument)
    ),

    load_opcode: $ => seq(
      "load",
      field("value", $.numeric_argument)
    ),

    store_opcode: $ => seq(
      "store",
      field("value", $.numeric_argument)
    ),

    pushints_opcode: $ => seq(
      "pushints",
      field("value", repeat(choice($.numeric_argument, $.template_variable)))
    ),

    double_numeric_argument_opcode: $ => seq(
      field("op", oneOf(DOUBLE_NUMERIC_ARGUMENT_OPCODES)),
      field("value_1", $.numeric_argument),
      field("value_2", $.numeric_argument)
    ),

    b_opcode: $ => seq(
      "b",
      $.label_identifier
    ),

    bz_opcode: $ => seq(
      "bz",
      $.label_identifier
    ),

    bnz_opcode: $ => seq(
      "bnz",
      $.label_identifier
    ),

    callsub_opcode: $ => seq(
      "callsub",
      $.label_identifier
    ),

    // `itxn F` -- or, with an array field and an index, the assembler's
    // itxna sugar (asmItxn).
    itxn_opcode: $ => seq(
      "itxn",
      choice(
        field("txn_field", $._txn_field),
        seq(field("txn_array_field", $._txna_field), field("index", $.numeric_argument))
      )
    ),

    itxn_field_opcode: $ => seq(
      "itxn_field",
      choice(
        field("txn_field", $._txn_field),
        field("txn_array_field", $._txna_field)
      )
    ),

    itxna_opcode: $ => seq(
      "itxna",
      field("txn_array_field", $._txna_field),
      field("index", $.numeric_argument)
    ),

    // `gitxn T F` -- or the gitxna sugar `gitxn T F I` (asmGitxn).
    gitxn_opcode: $ => seq(
      "gitxn",
      field("txn_group_index", $.numeric_argument),
      choice(
        field("txn_field", $._txn_field),
        seq(field("txn_array_field", $._txna_field), field("array_index", $.numeric_argument))
      )
    ),

    gitxna_opcode: $ => seq(
      "gitxna",
      field("txn_group_index", $.numeric_argument),
      field("txn_array_field", $._txna_field),
      field("array_index", $.numeric_argument)
    ),

    // Zero targets is valid (the assembler accepts an empty `switch`).
    match_opcode: $ => seq(
      "match",
      repeat($.label_identifier)
    ),

    switch_opcode: $ => seq(
      "switch",
      repeat($.label_identifier)
    ),

    txn_opcode: $ => seq(
      "txn",
      choice(
        field("txn_field", $._txn_field),
        seq(field("txn_array_field", $._txna_field), field("index", $.numeric_argument))
      )
    ),

    gtxns_opcode: $ => seq(
      "gtxns",
      choice(
        field("txn_field", $._txn_field),
        seq(field("txn_array_field", $._txna_field), field("index", $.numeric_argument))
      )
    ),

    gtxnsa_opcode: $ => seq(
      "gtxnsa",
      field("txn_array_field", $._txna_field),
      field("index", $.numeric_argument)
    ),

    txna_opcode: $ => seq(
      "txna",
      field("txn_array_field", $._txna_field),
      field("index", $.numeric_argument)
    ),

    txnas_opcode: $ => seq(
      "txnas",
      field("txn_array_field", $._txna_field),
    ),

    itxnas_opcode: $ => seq(
      "itxnas",
      field("txn_array_field", $._txna_field),
    ),

    gitxnas_opcode: $ => seq(
      "gitxnas",
      field("txn_group_index", $.numeric_argument),
      field("txn_array_field", $._txna_field),
    ),

    gtxnas_opcode: $ => seq(
      "gtxnas",
      field("txn_group_index", $.numeric_argument),
      field("txn_array_field", $._txna_field),
    ),

    gtxnsas_opcode: $ => seq(
      "gtxnsas",
      field("txn_array_field", $._txna_field),
    ),

    gtxn_opcode: $ => seq(
      "gtxn",
      $.numeric_argument,
      choice(
        field("txn_field", $._txn_field),
        seq(field("txn_array_field", $._txna_field), field("index", $.numeric_argument))
      )
    ),

    gtxna_opcode: $ => seq(
      "gtxna",
      $.numeric_argument,
      field("txn_array_field", $._txna_field),
      field("index", $.numeric_argument)
    ),

    global_opcode: $ => seq(
      "global",
      field("global_field", $._global_field)
    ),

    pushbytes_opcode: $ => seq(
      "pushbytes",
      field("value", choice($.numeric_argument, $._byte_value, $.template_variable))
    ),

    block_opcode: $ => seq(
      "block",
      field("block_field", $._block_field)
    ),

    unknown_opcode: $ => seq(
      field("op", $.label_identifier),
      repeat(choice(
        $.numeric_argument, $.string_argument, $.hexbytes_argument,
        $.template_variable, $.label_identifier,
      )),
    ),
  }
});
