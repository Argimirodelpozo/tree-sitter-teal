# tree-sitter-teal
Tree-sitter grammar definition for TEAL (Transaction Execution Approval Language), the Algorand Virtual Machine domain specific language.


When updating, edit grammar.js
Then do `tree-sitter generate` to re-generate the c parser and grammar.json. Every other one is just bindings into this one.