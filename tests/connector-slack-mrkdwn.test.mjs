import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { markdownToMrkdwn } from "../packages/connector-slack/dist/index.js";
import { postSlackMessage } from "../packages/connector-slack/dist/posting.js";
import { BasePlugin } from "../packages/plugin-sdk/dist/base-plugin.js";

test("converts **x** to Slack *x*", () => {
  assert.equal(markdownToMrkdwn("**x**"), "*x*");
});

test("converts __x__ to Slack *x*", () => {
  assert.equal(markdownToMrkdwn("__x__"), "*x*");
});

test("converts ~~x~~ to Slack ~x~", () => {
  assert.equal(markdownToMrkdwn("~~x~~"), "~x~");
});

test("converts [t](url) to the Slack link <url|t>", () => {
  assert.equal(markdownToMrkdwn("[t](url)"), "<url|t>");
});

test("converts every ATX heading level from # through ###### to a bold line", () => {
  assert.equal(
    markdownToMrkdwn("# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six"),
    "*One*\n*Two*\n*Three*\n*Four*\n*Five*\n*Six*",
  );
});

test("converts -, *, and + bullets while preserving nested indentation", () => {
  assert.equal(
    markdownToMrkdwn("- top\n  * nested\n    + deeper\n\t- tab-indented"),
    "• top\n  • nested\n    • deeper\n\t• tab-indented",
  );
});

test("preserves Markdown-looking text inside inline code", () => {
  assert.equal(markdownToMrkdwn("`**x** [a](b)`"), "`**x** [a](b)`");
});

test("preserves multiline fenced code with and without a language tag", () => {
  for (const openingFence of ["```js", "```"]) {
    const code = [openingFence, "**x** [a](b) &<>", "# heading", "- item", "~~~strike~~~", "```"].join("\n");
    const text = `Before **bold**.\n${code}\nAfter ~~strike~~.`;
    assert.equal(
      markdownToMrkdwn(text),
      `Before *bold*.\n${code}\nAfter ~strike~.`,
      `opening fence ${JSON.stringify(openingFence)}`,
    );
  }
});

test("escapes ampersands and angle brackets in normal text", () => {
  assert.equal(markdownToMrkdwn("A & B < C > D"), "A &amp; B &lt; C &gt; D");
});

test("keeps generated Slack link delimiters intact while escaping surrounding text", () => {
  assert.equal(markdownToMrkdwn("< [t](url) & more >"), "&lt; <url|t> &amp; more &gt;");
});

test("converts bold headings and list items, a link inside bold, and text around unchanged code", () => {
  const text = [
    "## **Heading**",
    "- **bold item** with **[link](url)** and `**code** [a](b)`",
    "Before **bold**.",
    "```js",
    "**block** [a](b) &<>",
    "second ~~line~~",
    "```",
    "After _italic_ & <>.",
  ].join("\n");

  assert.equal(
    markdownToMrkdwn(text),
    [
      "*Heading*",
      "• *bold item* with *<url|link>* and `**code** [a](b)`",
      "Before *bold*.",
      "```js",
      "**block** [a](b) &<>",
      "second ~~line~~",
      "```",
      "After _italic_ &amp; &lt;&gt;.",
    ].join("\n"),
  );
});

test("converts Markdown bold and strikethrough while preserving Slack mrkdwn", () => {
  assert.equal(
    markdownToMrkdwn("**bold** __also bold__ *existing bold* _italic_ ~~struck~~"),
    "*bold* *also bold* *existing bold* _italic_ ~struck~",
  );
  assert.equal(markdownToMrkdwn("**x** __x__ ~~x~~"), "*x* *x* ~x~");
  assert.equal(markdownToMrkdwn("*x* _y_"), "*x* _y_");
});

test("converts nested bold and italic without converting bold a second time", () => {
  assert.equal(markdownToMrkdwn("**bold and *italic***"), "*bold and _italic_*");
  assert.equal(markdownToMrkdwn("*italic and **bold***"), "_italic and *bold*_");
  assert.equal(markdownToMrkdwn("**bold with _italic_ inside**"), "*bold with _italic_ inside*");
});

test("converts Markdown links and formats their labels", () => {
  assert.equal(
    markdownToMrkdwn("[Owl](https://example.com) [**bold link**](https://example.com/bold) [*italic link*](https://example.com/italic)"),
    "<https://example.com|Owl> <https://example.com/bold|*bold link*> <https://example.com/italic|_italic link_>",
  );
  assert.equal(markdownToMrkdwn("[t](url)"), "<url|t>");
});

test("keeps bare autolinks and safely handles link delimiters", () => {
  assert.equal(
    markdownToMrkdwn("<https://example.com?a=1&b=2> [left | <right> & more](https://example.com/a|b<q>?x=1&y=2)"),
    "<https://example.com?a=1&b=2> <https://example.com/a%7Cb%3Cq%3E?x=1&y=2|left | &lt;right&gt; &amp; more>",
  );
  assert.equal(markdownToMrkdwn("Before < [t](url) > after"), "Before &lt; <url|t> &gt; after");
});

test("leaves bare URLs unchanged, including formatting marks and ampersands", () => {
  const url = "https://example.com/path_*bold*_?a=1&b=2";
  assert.equal(markdownToMrkdwn(`See ${url} for details.`), `See ${url} for details.`);
  assert.equal(markdownToMrkdwn(`www.example.com/?a=1&b=2`), "www.example.com/?a=1&b=2");
});

test("converts all heading levels to bold lines", () => {
  assert.equal(
    markdownToMrkdwn("# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six\n  ### Indented ###\n# **Already bold**\n## Mixed **bold** and *italic*"),
    "*One*\n*Two*\n*Three*\n*Four*\n*Five*\n*Six*\n  *Indented*\n*Already bold*\n*Mixed bold and _italic_*",
  );
});

test("converts unordered bullets while preserving indentation and numbered lists", () => {
  assert.equal(
    markdownToMrkdwn("- dash\n  * star\n\t+ plus\n1. numbered\n  12. also numbered"),
    "• dash\n  • star\n\t• plus\n1. numbered\n  12. also numbered",
  );
});

test("leaves inline code and its Markdown-looking contents unchanged", () => {
  const code = "`**bold** [link](https://example.com) # heading - dash * star + plus ~~strike~~ &<>`";
  assert.equal(markdownToMrkdwn(`Use ${code} as written.`), `Use ${code} as written.`);
  assert.equal(markdownToMrkdwn("`**x** <b> a & b`"), "`**x** <b> a & b`");
});

test("leaves fenced code with or without a language tag unchanged", () => {
  for (const openingFence of ["```ts", "```"]) {
    const code = [
      openingFence,
      "**bold** [link](https://example.com) &<>",
      "# heading",
      "- dash",
      "* star",
      "+ plus",
      "```",
    ].join("\n");
    const text = `Before **bold**.\n${code}\nAfter ~~strike~~.`;
    assert.equal(markdownToMrkdwn(text), `Before *bold*.\n${code}\nAfter ~strike~.`);
  }
});

test("preserves an unterminated fenced code block through the end of the message", () => {
  const text = "Before **bold**.\n```ts\nconst literal = `**unchanged** & <tag>`;\n# still code\n- still code";
  assert.equal(
    markdownToMrkdwn(text),
    "Before *bold*.\n```ts\nconst literal = `**unchanged** & <tag>`;\n# still code\n- still code",
  );
});

test("leaves tilde-fenced code and its Markdown-looking contents unchanged", () => {
  const code = [
    "~~~ts",
    "**bold** [link](https://example.com) &<>",
    "# heading",
    "- dash",
    "* star",
    "+ plus",
    "~~~",
  ].join("\n");
  assert.equal(
    markdownToMrkdwn(`Before **bold**.\n${code}\nAfter ~~strike~~.`),
    `Before *bold*.\n${code}\nAfter ~strike~.`,
  );
});

test("escapes plain text but preserves existing Slack tokens and entities", () => {
  const text = "A & B < C > D; mentions <@U123> <#C123> <!here> and <https://example.com|site> &amp; &lt;";
  assert.equal(
    markdownToMrkdwn(text),
    "A &amp; B &lt; C &gt; D; mentions <@U123> <#C123> <!here> and <https://example.com|site> &amp; &lt;",
  );
});

test("plain text escaping is stable when converted repeatedly", () => {
  const once = markdownToMrkdwn("Plain & text <tag> with &amp; and <@U123>.");
  assert.equal(markdownToMrkdwn(once), once);
});

test("preserves valid Slack asterisk bold and keeps conversion idempotent", () => {
  assert.equal(markdownToMrkdwn("*bold*"), "*bold*");
  assert.equal(markdownToMrkdwn("*italic* **bold**"), "*italic* *bold*");
  assert.equal(markdownToMrkdwn("*italic and **bold***"), "_italic and *bold*_");
  assert.equal(markdownToMrkdwn("**bold and *italic***"), "*bold and _italic_*");
  assert.equal(markdownToMrkdwn("*italic*\n# Heading"), "*italic*\n*Heading*");
  for (const source of ["**bold**", "__bold__", "# Heading", "*bold*"]) {
    const converted = markdownToMrkdwn(source);
    assert.equal(markdownToMrkdwn(converted), converted, `repeat conversion of ${JSON.stringify(source)}`);
  }
  assert.equal(markdownToMrkdwn(markdownToMrkdwn("[t](url)")), "<url|t>");
});

test("posting.ts converts Markdown before sending text as mrkdwn", async () => {
  const posts = [];
  await postSlackMessage({ chat: { postMessage: async (message) => posts.push(message) } }, {
    channel: "C-CONVERSION-TEST",
    text: "**bold** with *existing bold*, ~~strike~~, [link](url)\n# heading\n- bullet",
    mrkdwn: false,
  });

  assert.equal(posts[0].text, "*bold* with *existing bold*, ~strike~, <url|link>\n*heading*\n• bullet");
  assert.equal(posts[0].mrkdwn, true);
});

test("strips owl-actions fences at the Slack posting boundary", async () => {
  const posts = [];
  const actionFence = ["```owl-actions", '{"type":"create_work","secret":"action-payload"}', "```"].join("\n");
  await postSlackMessage({ chat: { postMessage: async (message) => posts.push(message) } }, {
    channel: "C-CONVERSION-TEST",
    text: `Visible reply.\n${actionFence}\nDone.`,
    blocks: [{
      type: "section",
      text: { type: "mrkdwn", text: `Visible block.\n${actionFence}\nDone.` },
    }],
  });

  assert.equal(posts[0].text, "Visible reply.\nDone.");
  assert.equal(posts[0].blocks[0].text.text, "Visible block.\nDone.");
  assert.equal(JSON.stringify(posts[0]).includes("action-payload"), false);
});

test("non-Slack plugin message posting leaves Markdown text unchanged", async () => {
  let requestBody;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requestBody = JSON.parse(Buffer.concat(chunks).toString());
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { message_id: "message-1" } }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  assert.ok(address && typeof address === "object");
  class TestPlugin extends BasePlugin {
    name = "test-plugin";
    async sendMessage(body) {
      return this.postMessage("conversation-1", body);
    }
  }

  const plugin = new TestPlugin({
    core_api_base: `http://127.0.0.1:${address.port}/api/v1`,
    plugin_name: "test-plugin",
  });
  const rawText = "**bold** ~~strike~~ [link](url)\n# heading\n- bullet";

  try {
    await plugin.sendMessage(rawText);
    assert.equal(requestBody.payload.body, rawText);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("passes through empty strings and ordinary plain text unchanged", () => {
  assert.equal(markdownToMrkdwn(""), "");
  const text = "Plain text stays unchanged.\nAnd so does this line.";
  assert.equal(markdownToMrkdwn(text), text);
});

test("converts mixed Markdown while retaining code and list structure", () => {
  const text = [
    "## Summary",
    "- **Ready** with [docs](https://example.com/docs)",
    "  + ~~Blocked~~",
    "1. Keep numbering",
    "`**inline stays literal**`",
  ].join("\n");
  assert.equal(
    markdownToMrkdwn(text),
    "*Summary*\n• *Ready* with <https://example.com/docs|docs>\n  • ~Blocked~\n1. Keep numbering\n`**inline stays literal**`",
  );
});

test("converts nested links, list formatting, headings, and text around a code fence", () => {
  const code = [
    "```js",
    "**inside** [link](url) & <tag>",
    "second line ~~also literal~~",
    "```",
  ].join("\n");
  const text = [
    "## Summary & <draft> >",
    "- **Ready** with [**bold link**](https://example.com/bold) and `**literal** <tag> &`",
    "  + ~~Blocked~~ with [docs](https://example.com/docs)",
    "### Heading with `**literal** <tag> &` & <extra> >",
    "Before **bold**.",
    code,
    "After **bold** & <text> > and ~~strike~~.",
  ].join("\n");

  assert.equal(
    markdownToMrkdwn(text),
    [
      "*Summary &amp; &lt;draft&gt; &gt;*",
      "• *Ready* with <https://example.com/bold|*bold link*> and `**literal** <tag> &`",
      "  • ~Blocked~ with <https://example.com/docs|docs>",
      "*Heading with `**literal** <tag> &` &amp; &lt;extra&gt; &gt;*",
      "Before *bold*.",
      code,
      "After *bold* &amp; &lt;text&gt; &gt; and ~strike~.",
    ].join("\n"),
  );
});

test("does not throw on incomplete Markdown", () => {
  assert.doesNotThrow(() => markdownToMrkdwn("[incomplete **bold & <text"));
});
