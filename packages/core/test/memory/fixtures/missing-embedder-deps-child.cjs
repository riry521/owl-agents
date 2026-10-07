// Simulates an optional transformers import failure through the embedder IPC protocol.
process.on("message", (message) => {
  if (message?.op === "init") {
    process.send?.({ op: "init_error", code: "missing", error: "Cannot find package '@huggingface/transformers'" });
  }
});
