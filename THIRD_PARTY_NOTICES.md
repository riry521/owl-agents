# Third-party notices

License information below was checked on 2026-10-03. Package versions and
license identifiers were read from the installed packages' `package.json`
files; bundled license files were checked where present. Model information was
checked against Hugging Face model cards and license files. Revisions are
unpinned unless stated otherwise: `memory-models.mjs` resolves model files from
the mutable `main` branch.

## npm dependencies added by this work

The package manifest diff from `main` adds the packages below. No MCP-server
specific package was added. All listed dependencies declare MIT or Apache-2.0;
`sqlite-vec` lets the user choose either license.

| Package | Version and use | License and copyright notice | Source |
|---|---|---|---|
| `@huggingface/transformers` | 4.3.0, optional runtime dependency | Apache-2.0 (`package.json` and bundled `LICENSE`). No explicit copyright line in the package license; `package.json` names Hugging Face as author. | [Repository](https://github.com/huggingface/transformers.js) |
| `sqlite-vec` | 0.1.9, optional runtime dependency | `MIT OR Apache-2.0`; either license may be selected (`package.json`). The npm package has no bundled license file. Upstream v0.1.9 license files state `Copyright (c) 2024 Alex Garcia`. | [Repository](https://github.com/asg017/sqlite-vec), [MIT](https://github.com/asg017/sqlite-vec/blob/v0.1.9/LICENSE-MIT), [Apache-2.0](https://github.com/asg017/sqlite-vec/blob/v0.1.9/LICENSE-APACHE) |
| `onnxruntime-node` | 1.30.0, optional transitive runtime dependency of Transformers.js | MIT (`package.json`). The npm package has no bundled license file; the upstream v1.30.0 `LICENSE` states `Copyright (c) Microsoft Corporation`. | [Repository](https://github.com/microsoft/onnxruntime), [LICENSE](https://github.com/microsoft/onnxruntime/blob/v1.30.0/LICENSE) |
| `better-sqlite3` | 12.6.2, runtime dependency | MIT (`package.json` and bundled `LICENSE`); `Copyright (c) 2017 Joshua Wise`. | [Repository](https://github.com/WiseLibs/better-sqlite3) |
| `@types/better-sqlite3` | 9.6.0, development dependency | MIT (`package.json` and bundled `LICENSE`); `Copyright (c) Microsoft Corporation`. | [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/better-sqlite3) |

## Embedding models: default and candidates

Model files are fetched by users with `node scripts/memory-models.mjs pull
<org/name>` and are not included in this repository. The eval and pull scripts
accept arbitrary Hugging Face IDs; the rows below cover the configured model,
the model families handled by `embedder.ts`, the E5 size variants documented
in the READMEs, and the models used in the comparison.

| Model / role | Revision | License | Copyright notice | Source and notes |
|---|---|---|---|---|
| `Xenova/multilingual-e5-small` — default ONNX model | Unpinned (`main`) | The conversion repository does not declare a separate license in its card. Its card identifies `intfloat/multilingual-e5-small` as the base model, whose card declares MIT. | No explicit copyright notice found in either model card. | [ONNX model card](https://huggingface.co/Xenova/multilingual-e5-small), [base model card](https://huggingface.co/intfloat/multilingual-e5-small) |
| `intfloat/multilingual-e5-small` — original model | Unpinned | MIT (model card) | No explicit copyright notice found in the model card. | [Model card](https://huggingface.co/intfloat/multilingual-e5-small) |
| `Xenova/multilingual-e5-base` — documented E5 candidate | Unpinned (`main`) | The conversion repository does not declare a separate license in its card. Its card identifies `intfloat/multilingual-e5-base` as the base model, whose card declares MIT. | No explicit copyright notice found in either model card. | [ONNX model card](https://huggingface.co/Xenova/multilingual-e5-base), [base model card](https://huggingface.co/intfloat/multilingual-e5-base) |
| `intfloat/multilingual-e5-base` — original model | Unpinned | MIT (model card) | No explicit copyright notice found in the model card. | [Model card](https://huggingface.co/intfloat/multilingual-e5-base) |
| `Xenova/multilingual-e5-large` — documented E5 candidate | Unpinned (`main`) | The conversion repository does not declare a separate license in its card. Its card identifies `intfloat/multilingual-e5-large` as the base model, whose card declares MIT. | No explicit copyright notice found in either model card. | [ONNX model card](https://huggingface.co/Xenova/multilingual-e5-large), [base model card](https://huggingface.co/intfloat/multilingual-e5-large) |
| `intfloat/multilingual-e5-large` — original model | Unpinned | MIT (model card) | No explicit copyright notice found in the model card. | [Model card](https://huggingface.co/intfloat/multilingual-e5-large) |
| `cl-nagoya/ruri-v3-310m` — Ruri source model | Unpinned (`main`) | Apache-2.0 (model card) | The card cites the model authors but contains no explicit copyright line. | [Model card and license](https://huggingface.co/cl-nagoya/ruri-v3-310m) |
| `mochiya98/ruri-v3-310m-onnx` — ONNX model used in the comparison | Unpinned (`main`) | Apache-2.0 (Hugging Face model license metadata); it is listed as a quantization of the Ruri source model. | No explicit copyright notice found in the ONNX model card. | [ONNX model card](https://huggingface.co/mochiya98/ruri-v3-310m-onnx), [source model card](https://huggingface.co/cl-nagoya/ruri-v3-310m) |
| `Qwen/Qwen3-Embedding-0.6B` — Qwen source model | Unpinned (`main`) | Apache-2.0 (model card) | No explicit copyright notice found in this model card or its files. The related Qwen3-0.6B license file states `Copyright 2024 Alibaba Cloud`; this is linked as source-model context, not as a separate notice for the embedding repository. | [Model card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B), [related Qwen3 license](https://huggingface.co/Qwen/Qwen3-0.6B/blob/main/LICENSE) |
| `onnx-community/Qwen3-Embedding-0.6B-ONNX` — ONNX model used in the comparison | Unpinned (`main`) | Not stated separately in the ONNX model card. Its card points to `Qwen/Qwen3-Embedding-0.6B`, whose card declares Apache-2.0. | No explicit copyright notice found in the ONNX model card. | [ONNX model card](https://huggingface.co/onnx-community/Qwen3-Embedding-0.6B-ONNX), [source model card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) |

### Ruri v3 decision

Ruri v3 is retained as a candidate. On 2026-10-03, the source model card
declared Apache-2.0, and the ONNX model used in the comparison also declared
Apache-2.0 in its Hugging Face license metadata. Both license declarations
permit use and redistribution subject to their terms. The links and license
names are listed in the two Ruri rows above.
