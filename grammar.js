/**
 * @file Tree sitter parser for the TEAL DSL (Algorand Virtual Machine assembly language)
 * @author Argimiro del Pozo
 * @license MIT
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

const ZERO_ARGUMENT_OPCODES = [
  "sha256", "keccak256", "sha512_256",
  "err",
  "ed25519verify",
  "+", "-", "*", "/", "%", // Math
  "<", "<=", ">", ">=", "&&", "||", "==", "!=", "!", // Boolean
  "len", "itob", "btoi",
  "&", "|", "^", "~", // Bitwise operations
  "mulw", "addw", "divmodw",
  "intc_0", "intc_1", "intc_2", "intc_3",
  "bytec_0", "bytec_1", "bytec_2", "bytec_3",
  "arg_0", "arg_1", "arg_2", "arg_3",
  "gaids", "loads",
  "gaid",
  "stores",
  "return",
  "assert",
  "pop", "dup", "dup2",
  "swap", "select",
  "concat",
  "substring3", "getbit", "setbit",
  "getbyte", "setbyte",
  "extract_uint16", "extract_uint32", "extract_uint64",
  "replace3",
  "extract3",
  "balance",
  "app_opted_in", "app_local_get", "app_local_get_ex",
  "app_global_get", "app_global_get_ex",
  "app_local_put", "app_global_put",
  "app_local_del", "app_global_del",
  "online_stake",
  "min_balance",
  "ed25519verify_bare",
  "retsub",
  "shl", "shr", "sqrt",
  "bitlen", "exp",
  "expw", "bsqrt", "divw",
  "sha3_256",
  "b+", "b-", "b/", "b*", "b<", "b>", "b<=", "b>=", "b==", "b!=",
  "b%", "b|", "b&", "b^", "b~", "bzero", 
  "log", "itxn_begin", "itxn_submit", "itxn_next",
  "box_create", "box_extract", "box_replace", "box_del",
  "box_len", "box_get", "box_put",
  "args", "gloadss",
  "box_splice", "box_resize",
];

const SINGLE_NUMERIC_ARGUMENT_OPCODES = [
  "bytec",
  "arg",
  // "load", "store",
  "gloads",
  "bury",
  "popn", "dupn",
  "dig", "cover", "uncover",
  "replace2",
  "pushint",
  "frame_dig", "frame_bury",
  //pseudo-opcode but included for completeness
  "int"
];

const DOUBLE_NUMERIC_ARGUMENT_OPCODES = [
  "extract", "substring",
  "gload",
  "proto",
];

const TXN_FIELDS = [
  "Sender","Fee","FirstValid","FirstValidTime","LastValid",
  "Note","Lease","Receiver","Amount","CloseRemainderTo","VotePK",
  "SelectionPK","VoteFirst","VoteLast","VoteKeyDilution","Type","TypeEnum",
  "XferAsset","AssetAmount","AssetSender","AssetReceiver","AssetCloseTo",
  "GroupIndex","TxID","ApplicationID","OnCompletion","NumAppArgs","NumAccounts",
  "ApprovalProgram","ClearStateProgram","RekeyTo","ConfigAsset","ConfigAssetTotal",
  "ConfigAssetDecimals","ConfigAssetDefaultFrozen","ConfigAssetUnitName","ConfigAssetName",
  "ConfigAssetURL","ConfigAssetMetadataHash","ConfigAssetManager","ConfigAssetReserve",
  "ConfigAssetFreeze","ConfigAssetClawback","FreezeAsset","FreezeAssetAccount",
  "FreezeAssetFrozen","NumAssets","NumApplications","GlobalNumUint","GlobalNumByteSlice",
  "LocalNumUint","LocalNumByteSlice","ExtraProgramPages","Nonparticipation","NumLogs",
  "CreatedAssetID","CreatedApplicationID","LastLog","StateProofPK","NumApprovalProgramPages",
  "NumClearStateProgramPages"
];

const TXN_ARRAY_FIELDS = [
  "ApplicationArgs","Accounts","Assets","Applications","Logs","ApprovalProgramPages",
  "ClearStateProgramPages"
];

const GLOBAL_FIELDS = [
  "MinTxnFee","MinBalance","MaxTxnLife","ZeroAddress","GroupSize","LogicSigVersion","Round",
  "LatestTimestamp","CurrentApplicationID","CreatorAddress","CurrentApplicationAddress","GroupID",
  "OpcodeBudget","CallerApplicationID","CallerApplicationAddress","AssetCreateMinBalance",
  "AssetOptInMinBalance","GenesisHash","PayoutsEnabled","PayoutsGoOnlineFee","PayoutsPercent",
  "PayoutsMinBalance","PayoutsMaxBalance"
];

const ASSET_PARAMS = [
  "AssetTotal","AssetDecimals","AssetDefaultFrozen","AssetUnitName","AssetName","AssetURL",
  "AssetMetadataHash","AssetManager","AssetReserve","AssetFreeze","AssetClawback","AssetCreator"
];

const APP_PARAMS = [
  "AppApprovalProgram","AppClearStateProgram","AppGlobalNumUint","AppGlobalNumByteSlice",
  "AppLocalNumUint","AppLocalNumByteSlice","AppExtraProgramPages","AppCreator","AppAddress"
];

const ACCOUNT_PARAMS = [
  "AcctBalance","AcctMinBalance","AcctAuthAddr","AcctTotalNumUint","AcctTotalNumByteSlice",
  "AcctTotalExtraAppPages","AcctTotalAppsCreated","AcctTotalAppsOptedIn","AcctTotalAssetsCreated",
  "AcctTotalAssets","AcctTotalBoxes","AcctTotalBoxBytes","AcctIncentiveEligible","AcctLastProposed",
  "AcctLastHeartbeat"
];

const VOTER_PARAMS = ["VoterBalance", "VoterIncentiveEligible"];

const BLOCK_FIELDS = [
  "BlkSeed","BlkTimestamp","BlkProposer","BlkFeesCollected","BlkBonus","BlkBranch","BlkFeeSink",
  "BlkProtocol","BlkTxnCounter","BlkProposerPayout"
];


const NUMBER = /\d+/;
const STRING = /"[ -~]+"/;
const HEX_BYTES = /0x[A-Fa-f0-9]*/;

module.exports = grammar({
  name: "teal",

  // Extras is an array of tokens that is allowed anywhere in the document.
  extras: ($) => [
    // Allow comments to be placed anywhere in the file
    $.comment,
    // Allow characters such as whitespaces to be placed anywhere in the file
    /[\s\uFEFF\u2060\u200B\u00A0]/,
  ],

  // The word token allows tree-sitter to appropriately handle scenario's where an identifier includes a keyword.
  // Documentation: https://tree-sitter.github.io/tree-sitter/creating-parsers#keywords
  word: ($) => $.label_identifier,

  // error for multilabel branch of the form e.g. 'switch switch label'
  conflicts: $ => [
    [$.match_opcode], [$.switch_opcode]
  ],

  rules: {
    //  -- [ Contract ] --
    source: ($) => seq(repeat($._expression)),

    _expression: $ => choice(
      $.pragma,
      $.label,

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
      $.vrf_verify_opcode,

      $.asset_holding_get_opcode,
      $.asset_params_get_opcode,
      $.app_params_get_opcode,
      $.acct_params_get_opcode,
      $.voter_params_get_opcode,

      $.base64_decode_opcode,
      $.json_ref_opcode,

      $.intcblock_opcode,
      $.bytecblock_opcode,
      $.pushbytess_opcode,
      $.pushints_opcode,
      $.pushbytes_opcode,

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
    ),

    numeric_argument: (_) => NUMBER,

    comment: (_) => token(seq("\/\/", /(\\(.|\r?\n)|[^\\\n])*/)),

    // TEAL pragmas (e.g., #pragma version 6)
    pragma: $ => seq(
      "#pragma",
      "version",
      field("version", NUMBER)
    ),

    label_identifier: (_) => /[a-zA-Z_][a-zA-Z0-9_\-]*/,

    // Labels (e.g., start:)
    label: $ => seq(
      field("name", $.label_identifier),
      ":"
    ),

    zero_argument_opcode: $ => choice(...ZERO_ARGUMENT_OPCODES),

    ecdsa_opcode: $ => seq(
      field("op", choice("ecdsa_verify", "ecdsa_pk_decompress", "ecdsa_pk_recover")),
      choice("Secp256k1", "Secp256r1")
    ),

    ec_opcode: $ => seq(
      field("op", choice("ec_add", "ec_scalar_mul", "ec_pairing_check", 
        "ec_multi_scalar_mul", "ec_subgroup_check", "ec_map_to")),
      choice("BN254g1", "BN254g2", "BLS12_381g1", "BLS12_381g2")
    ),

    mimc_opcode: $ => seq(
      "mimc",
      choice("BN254Mp110", "BLS12_381Mp111")
    ),

    asset_holding_get_opcode: $ => seq(
      "asset_holding_get",
      choice("AssetBalance", "AssetFrozen")
    ),

    asset_params_get_opcode: $ => seq(
      "asset_params_get",
      choice(...ASSET_PARAMS),
    ),

    app_params_get_opcode: $ => seq(
      "app_params_get",
      choice(...APP_PARAMS)
    ),

    acct_params_get_opcode: $ => seq(
      "acct_params_get",
      choice(...ACCOUNT_PARAMS)
    ),

    voter_params_get_opcode: $ => seq(
      "voter_params_get",
      choice(...VOTER_PARAMS)
    ),

    base64_decode_opcode: $ => seq(
      "base64_decode",
      choice("URLEncoding", "StdEncoding")
    ),

    json_ref_opcode: $ => seq(
      "json_ref",
      choice("JSONString", "JSONUint64", "JSONObject")
    ),

    vrf_verify_opcode: $ => seq(
      "vrf_verify",
      "VrfAlgorand"
    ),

    intcblock_opcode: $ => seq(
      "intcblock",
      field("value", repeat($.numeric_argument)),
    ),

    bytecblock_opcode: $ => seq(
      "bytecblock",
      repeat(choice(NUMBER, STRING, HEX_BYTES))
    ),

    pushbytess_opcode: $ => seq(
      "pushbytess",
      repeat(choice(NUMBER, STRING, HEX_BYTES))
    ),

    single_numeric_argument_opcode: $ => seq(
      field("op", choice(...SINGLE_NUMERIC_ARGUMENT_OPCODES)),
      field("value", $.numeric_argument)
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
      field("value", repeat(NUMBER))
    ),

    double_numeric_argument_opcode: $ => seq(
      field("op", choice(...DOUBLE_NUMERIC_ARGUMENT_OPCODES)),
      field("argument_1", NUMBER),
      field("argument_2", NUMBER)
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

    itxn_opcode: $ => seq(
      "itxn",
      choice(...TXN_FIELDS)
    ),

    itxn_field_opcode: $ => seq(
      "itxn_field",
      choice(...TXN_FIELDS)
    ),

    itxna_opcode: $ => seq(
      "itxna",
      choice(...TXN_ARRAY_FIELDS)
    ),

    gitxn_opcode: $ => seq(
      "gitxn",
      field("txn_group_index", NUMBER),
      choice(...TXN_FIELDS)
    ),

    gitxna_opcode: $ => seq(
      "gitxna",
      field("txn_group_index", NUMBER),
      choice(...TXN_ARRAY_FIELDS),
      field("array_index", NUMBER)
    ),

    match_opcode: $ => seq(
      "match",
      repeat1($.label_identifier)
    ),

    switch_opcode: $ => seq(
      "switch",
      repeat1($.label_identifier)
    ),

    txn_opcode: $ => seq(
      "txn",
      choice(
        choice(...TXN_FIELDS),
        seq(choice(...TXN_ARRAY_FIELDS), field("array_index", NUMBER))
      )
    ),

    gtxns_opcode: $ => seq(
      "gtxns",
      choice(
        choice(...TXN_FIELDS),
        seq(choice(...TXN_ARRAY_FIELDS), field("array_index", NUMBER))
      )
    ),

    gtxnsa_opcode: $ => seq(
      "gtxnsa",
      choice(...TXN_ARRAY_FIELDS),
      field("array_index", NUMBER)
    ),

    _txna_field: $ => choice(...TXN_ARRAY_FIELDS),

    txna_opcode: $ => seq(
      "txna",
      field("txna_field", $. _txna_field),
      field("index", NUMBER)
    ),

    txnas_opcode: $ => seq(
      "txnas",
      choice(...TXN_ARRAY_FIELDS),
    ),

    itxnas_opcode: $ => seq(
      "itxnas",
      choice(...TXN_ARRAY_FIELDS),
    ),

    gitxnas_opcode: $ => seq(
      "gitxnas",
      field("txn_group_index", NUMBER),
      choice(...TXN_ARRAY_FIELDS),
    ),

    gtxnas_opcode: $ => seq(
      "gtxnas",
      field("txn_group_index", NUMBER),
      choice(...TXN_ARRAY_FIELDS),
    ),

    gtxnsas_opcode: $ => seq(
      "gtxnsas",
      choice(...TXN_ARRAY_FIELDS),
    ),

    gtxn_opcode: $ => seq(
      "gtxn",
      NUMBER,
      choice(
        choice(...TXN_FIELDS),
        seq(choice(...TXN_ARRAY_FIELDS), field("array_index", NUMBER))
      )
    ),

    gtxna_opcode: $ => seq(
      "gtxna",
      NUMBER,
      choice(...TXN_ARRAY_FIELDS),
      field("array_index", NUMBER)
    ),

    global_opcode: $ => seq(
      "global",
      choice(...GLOBAL_FIELDS)
    ),

    pushbytes_opcode: $ => seq(
      "pushbytes",
      choice(NUMBER, STRING, HEX_BYTES)
    ),

    block_opcode: $ => seq(
      "block",
      choice(...BLOCK_FIELDS)
    ),
  }
});
