import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { homedir } from "node:os";
import { after, before, test } from "node:test";

import { repoRoot } from "../helpers/paths.mjs";

// Drives the real AdvisorView in mobile Chromium / WebKit. The repo has no
// browser-test dependency, so playwright-core and esbuild are borrowed from
// OWL_BROWSER_TEST_DIR (default: another local project); skipped if unavailable.
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
export const getAdvisorWindowConversation = async () => 'conv1';
export const getAdvisorWindowChannels = async () => [];
export const createAdvisorWindowChannel = async () => {};
export const bindAdvisorWindowChannel = async () => {};
export const renameAdvisorWindowChannel = async () => {};
export const getAdvisorSession = async () => ({ running_turns: 0, queued_turns: 0 });
export const listMessages = async () => [{ id: 'm0', conversation_id: 'conv1', source: 'advisor', body: 'hi', attachment_ids: [], created_at: '2026-01-01T00:00:00Z' }];
export const ingestConversation = async () => {};
export const clearAdvisorConversation = async () => {};
export const subscribeToUpdates = () => () => {};
export const postMessage = async (_id, body) => { (window.__posts ??= []).push(body); if (window.__hold) await new Promise((r) => { window.__release = r; }); return { message_id: 'm' + window.__posts.length }; };
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
        // Count renders: useView runs once per AdvisorView body render, formatRelative once per Turn render.
        b.onResolve({ filter: /^@\/lib\/(view-loader|format)$/ }, (a) => ({ path: a.path, namespace: "counted" }));
        b.onLoad({ filter: /.*/, namespace: "counted" }, (a) => a.path.endsWith("view-loader")
          ? { contents: `import { useView as real } from ${JSON.stringify(join(webDir, "lib/view-loader.ts"))}; export const useView = (...a) => { window.__bodyRenders = (window.__bodyRenders ?? 0) + 1; return real(...a); };`, loader: "js", resolveDir: webDir }
          : { contents: `import * as real from ${JSON.stringify(join(webDir, "lib/format.ts"))}; export * from ${JSON.stringify(join(webDir, "lib/format.ts"))}; export const formatRelative = (...a) => { window.__turnRenders = (window.__turnRenders ?? 0) + 1; return real.formatRelative(...a); };`, loader: "js", resolveDir: webDir });
        b.onResolve({ filter: /^@\/lib\/api-client$/ }, () => ({ path: "api", namespace: "stub" }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: stubApi, loader: "js", resolveDir: webDir }));
        // next/link reads process.env in the browser bundle; the panel only needs the import to resolve.
        b.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "stub-link" }));
        b.onLoad({ filter: /.*/, namespace: "stub-link" }, () => ({
          contents: 'import { createElement } from "react"; export default ({ href, children, ...p }) => createElement("a", { href, ...p }, children);',
          loader: "js",
          resolveDir: webDir,
        }));
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
  // The mount's own resize frame must run before the observer starts; with a slow machine it can otherwise land mid-test.
  await page.clock.fastForward(100);
  // Every change of the style attribute (i.e. style.height) is one record.
  // Start from a px height so the product's reset to "" is a real write, as in use after the first resize.
  await page.evaluate(() => {
    document.querySelector("textarea").style.height = "40px";
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
  test(`${engine} mobile keeps height and value unchanged mid-composition, resizes once on end, and sends the text intact`, { skip }, async () => {
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
    const end = await state(page);
    // With field-sizing the browser sizes the box and no JS runs; without it, one resize (auto, then px) runs after composition end.
    const native = await page.evaluate(() => CSS.supports("field-sizing: content"));
    assert.equal(end.writes, initial.writes + (native ? 0 : 2));
    if (!native) assert.match(end.height, /^\d+px$/);
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

  test(`${engine} desktop sends on Shift+Enter and ignores the Enter that confirms a composition`, { skip }, async () => {
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

test("typing re-renders neither AdvisorView nor the turns", { skip }, async () => {
  const page = await open("chromium", false);
  await page.waitForSelector(".turn");
  const counts = () => page.evaluate(() => [window.__bodyRenders, window.__turnRenders]);
  const before = await counts();
  assert.ok(before[0] > 0 && before[1] > 0, "counters are wired");
  await page.locator("textarea").pressSequentially("hello world", { delay: 5 });
  await page.clock.fastForward(100);
  assert.equal(await page.locator("textarea").inputValue(), "hello world");
  assert.deepEqual(await counts(), before);
  await page.context().close();
});

test("keeps input enabled and empty while sending, and refocuses the textarea afterwards", { skip }, async () => {
  const page = await open("chromium", false);
  const ta = page.locator("textarea");
  const send = page.locator("button.advisor__send");
  await page.evaluate(() => { window.__hold = true; });
  await ta.fill("hello");
  await send.click();
  await page.waitForFunction(() => window.__posts?.length === 1 && window.__release);
  assert.ok(await ta.isEnabled(), "textarea stays enabled while sending");
  assert.equal(await ta.inputValue(), "", "textarea cleared before the response");
  assert.ok(await send.isDisabled(), "send button disabled while sending");
  await ta.evaluate((el) => el.blur());
  await page.evaluate(() => { window.__hold = false; window.__release(); });
  await page.waitForFunction(() => document.activeElement === document.querySelector("textarea"));
  assert.ok(await ta.isEnabled());
  assert.equal(await ta.inputValue(), "");
  await page.context().close();
});
