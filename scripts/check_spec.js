#!/usr/bin/env node
/**
 * Verify that the generated parser accepts EVERY opcode and EVERY field of the
 * pinned AVM spec (vocab/avm.json), in every immediate form the spec defines.
 *
 *   tree-sitter generate && node scripts/check_spec.js
 *
 * For each spec opcode one instruction per field value is synthesised (numeric
 * immediates get `1`, branch targets get a label defined in the program,
 * constant blocks get literals), plus the assembler pseudo-op forms and the
 * named `int` constants. The program is parsed with the tree-sitter CLI and
 * every line must come back as exactly ONE top-level node that spans the whole
 * line and is neither ERROR, MISSING nor `unknown_opcode`.
 */
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const VOCAB = require(path.join(ROOT, "vocab", "avm.json"));

function immediateValues(op, imm) {
  if (imm.reference) return op.fields.map((f) => f.name);
  if (imm.name.startsWith("TARGET")) return imm.name.endsWith("...") ? ["target target"] : ["target"];
  if (imm.name === "UINT ...") return ["1 0x2 3_000"];
  if (imm.name === "UINT") return ["1"];
  if (imm.name === "BYTES ...") return ['"a" 0x0102 base64(AA==)'];
  if (imm.name === "BYTES") return ['"a"'];
  return ["1"];
}

// The langspec's "txn Fields" enumeration also lists the ARRAY fields, but the
// one-field forms only take scalars (opcodes.go: TxnScalarFields); an array
// field there is the assembler's txna sugar and takes an index too.
const ARRAY_FIELDS = new Set(VOCAB.ops.txna.fields.map((f) => f.name));
const TXNA_SUGAR = new Set(["txn", "gtxn", "gtxns", "itxn", "gitxn"]);

/** Every immediate combination of `op`, one per field value. */
function instructions(name, op) {
  let lines = [name];
  for (const imm of op.immediates) {
    let vals = immediateValues(op, imm);
    if (imm.reference && TXNA_SUGAR.has(name)) {
      vals = vals.map((v) => (ARRAY_FIELDS.has(v) ? `${v} 0` : v));
    }
    lines = lines.flatMap((l) => vals.map((v) => `${l} ${v}`));
  }
  return lines;
}

const program = ["#pragma version " + VOCAB.spec.avm_version, "target:"];
for (const [name, op] of Object.entries(VOCAB.ops)) program.push(...instructions(name, op));
// Assembler pseudo-ops.
for (const c of Object.keys(VOCAB.named_int_constants)) program.push(`int ${c}`);
program.push(
  "int 0x10", "int 010", "int 0b101", "int 0o17", "int 1_000_000", "int TMPL_X", "pushint TMPL_X",
  "byte 0x00", 'byte "s"', "byte base64(AA==)", "byte b64 AA//", "byte base32(AA)", "byte b32 AA",
  "byte TMPL_X", "addr AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ",
  'method "add(uint64,uint64)uint64"', "extract", "replace", "replace 1",
);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "teal-spec-"));
const file = path.join(dir, "spec.teal");
fs.writeFileSync(file, program.join("\n") + "\n");

let out;
try {
  out = execFileSync("tree-sitter", ["parse", file], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
} catch (e) {
  out = e.stdout; // a parse with errors exits non-zero; the tree is still printed
}

// Top-level children print at two-space indentation: `  (type [r, c] - [r, c]`.
const top = new Map();
for (const m of out.matchAll(/^  \((\w+) \[(\d+), (\d+)\] - \[(\d+), (\d+)\]/gm)) {
  const [, type, sr, sc, er, ec] = m;
  if (type === "comment") continue;
  const row = Number(sr);
  if (!top.has(row)) top.set(row, []);
  top.get(row).push({ type, sc: Number(sc), er: Number(er), ec: Number(ec) });
}

const failures = [];
program.forEach((line, row) => {
  const nodes = top.get(row) || [];
  const ok = nodes.length === 1 && nodes[0].type !== "ERROR" && nodes[0].type !== "unknown_opcode"
    && nodes[0].sc === 0 && nodes[0].er === row && nodes[0].ec === Buffer.byteLength(line);
  if (!ok) failures.push(`${row + 1}: ${line}  ->  ${JSON.stringify(nodes)}`);
});
if (/MISSING/.test(out)) failures.push("a MISSING node was inserted");

fs.rmSync(dir, { recursive: true, force: true });
const nOps = Object.keys(VOCAB.ops).length;
if (failures.length) {
  console.error(`${failures.length} of ${program.length} spec lines did not parse cleanly:`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`OK: ${program.length} lines covering all ${nOps} opcodes of AVM v${VOCAB.spec.avm_version} `
  + `(go-algorand ${VOCAB.spec.commit.slice(0, 10)}), every field, and the assembler pseudo-ops`);
