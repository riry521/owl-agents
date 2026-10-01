import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

// Drives the real AdvisorView in mobile Chromium / WebKit. The repo has no
// browser-test dependency, so playwright-core and esbuild are borrowed from
// OWL_BROWSER_TEST_DIR (default: another local project); skipped if unavailable.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webDir = join(repoRoot, "apps/web");
const advisorSrc = process.env.OWL_ADVISOR_SRC ?? join(webDir, "components/AdvisorView.tsx");
const toolsDir = process.env.OWL_BROWSER_TEST_DIR ?? join(homedir(), "stock-research/engine");

let esbuild, pw;
try {
  const req = createRequire(join(toolsDir, "package.json"));
  esbuild = req("esbuild");
  pw = req("playwright-core");
} catch {}
const skip = esbuild ? false : "playwright-core / esbuild not available";

const stubApi = `
export const getOwnerLanguage = async () => 'ja';
export const getActiveConversation= async () => 'conv1';
export const getAdvisorSession = async () => ({ running_turns: 0, queued_turns: 0 });
export const listMessages = async () => [];
export const ingestConversation = async () => {};
export const clearAdvisorConversation = async () => {};
export const postMessage = async (_id, body) => { (window.__posts ??= []).push(body); return { message_id: 'm' + window.__posts.length }; };
`;

let bundle;
const browsers = {};
before(async () => {
  if (skip) return;
  const result = await esbuild.build({
    stdin: {
      contents: `import { createRoot } from 'react-dom/client';
        import { AdvisorView } from ${JSON.stringify(advisorSrc)};
        import { LocaleProvider } from '@/lib/i18n';
        createRoot(document.getElementById('root')).render(<LocaleProvider><AdvisorView /></LocaleProvider>);`,
      resolveDir: webDir,
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    tsconfig: join(webDir, "tsconfig.json"),
    define: { "process.env.NODE_ENV": '"development"' },
    nodePaths: [join(webDir, "node_modules")],
    plugins: [{
      name: "stub-api",
      setup(b) {
        b.onResolve({ filter: /^@\/lib\/api-client$/ }, () => ({ path: "api", namespace: "stub" }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: stubApi, loader: "js", resolveDir: webDir }));
      },
    }],
  });
  bundle = result.outputFiles[0].text;
});
after(async () => {
  for (const b of Object.values(browsers)) await b.close();
});

// Mobile = touch emulation (sends by button only); desktop = Shift+Enter sends.
async function open(engine, mobile) {
  browsers[engine] ??= await pw[engine].launch();
  const device = mobile ? pw.devices[engine === "webkit" ? "iPhone 13" : "Pixel 7"] : {};
  const page = await (await browsers[engine].newContext(device)).newPage();
  page.on("pageerror", (e) => { throw e; });
  await page.clock.install();
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundle });
  await page.waitForSelector("textarea");
  // Every change of the style attribute (i.e. style.height) is one record.
  await page.evaluate(() => {
    window.__heightObserver = new MutationObserver((records) => { window.__heightWrites += records.length; });
    window.__heightObserver.observe(document.querySelector("textarea"), { attributes: true, attributeFilter: ["style"] });
    window.__heightWrites = 0;
    document.querySelector("textarea").dataset.mounted = "first";
  });
  return page;
}

// One IME step with the whole value, firing the events a flick keyboard does.
const compose = (page, type, text) => page.evaluate(([type, text]) => {
  const ta = document.querySelector("textarea");
  if (type === "start") ta.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  if (type !== "end") {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, text);
    ta.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", isComposing: true, data: text }));
    ta.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: text }));
  } else {
    ta.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: text }));
  }
}, [type, text]);
const state = (page) => page.evaluate(() => {
  const ta = document.querySelector("textarea");
  window.__heightWrites += window.__heightObserver.takeRecords().length;
  return { mounted: ta.dataset.mounted, value: ta.value, height: ta.style.height, writes: window.__heightWrites };
});

for (const engine of ["chromium", "webkit"]) {
  test(`${engine} mobile: no height/value change mid-composition, one resize on end, text sent intact`, { skip }, async () => {
    const page = await open(engine, true);
    const initial = await state(page);
    await compose(page, "start", "か");
    await compose(page, "update", "か");
    // Polling re-renders the view (new messages array each time) mid-composition.
    await page.clock.fastForward(20_000);
    await compose(page, "update", "が");
    await page.clock.fastForward(20_000);
    const mid = await state(page);
    assert.equal(mid.mounted, "first", "textarea was not remounted");
    assert.equal(mid.writes, initial.writes,"no style.height write during composition");
    assert.equal(mid.height, initial.height);
    assert.equal(mid.value, "が", "polling did not reset the unconfirmed value");
    await compose(page, "end", "が");
    assert.equal((await state(page)).writes, initial.writes + 2, "one resize (auto, then px) after composition end");
    let text = "が";
    for (const ch of ["ぱ", "っ", "ゃ"]) {
      await compose(page, "start", text + ch);
      await compose(page, "end", ch);
      text += ch;
    }
    await page.locator("button.advisor__send").click();
    await page.waitForFunction(() => window.__posts?.length === 1);
    assert.equal(await page.evaluate(() => window.__posts[0]), "がぱっゃ");
    await page.context().close();
  });

  test(`${engine} desktop: Shift+Enter sends, composition-confirm Enter does not`, { skip }, async () => {
    const page = await open(engine, false);
    const ta = page.locator("textarea");
    const key = (init) => ta.evaluate((el, init) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init })), init);
    await ta.fill("こんにちは");
    await key({ shiftKey: true, isComposing: true });
    await key({ shiftKey: true, keyCode: 229 });
    await compose(page, "start", "こんにちはあ");
    await key({ shiftKey: true });
    await compose(page, "end", "あ");
    assert.equal(await page.evaluate(() => window.__posts?.length ?? 0), 0, "no send on composition Enter");
    await ta.press("Shift+Enter");
    await page.waitForFunction(() => window.__posts?.length === 1);
    assert.equal(await page.evaluate(() => window.__posts[0]), "こんにちはあ");
    await page.context().close();
  });
}
