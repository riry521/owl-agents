import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyResearchTarget,
  filterResearchLinks,
  isPrivateResearchHost,
  looksLikeLoginPage,
  normalizeResearchQuery,
  normalizeResearchUrl,
  redactResearchText,
} from "../packages/core/dist/research-filter.js";

test("normalizes URL schemes, tracking, fragments, parameters, and trailing slashes", () => {
  assert.equal(normalizeResearchUrl("http://Example.test:80/a/?utm_source=mail&z=2&a=1#section"), "https://example.test/a?a=1&z=2");
  assert.equal(normalizeResearchUrl("https://example.test:443/"), "https://example.test/");
  assert.equal(normalizeResearchUrl("https://example.test/a/?fbclid=abc"), "https://example.test/a");
  assert.equal(normalizeResearchUrl("not a url"), null);
});

test("normalizes search terms with NFKC and collapsed whitespace", () => {
  assert.equal(normalizeResearchQuery("  Ｏｗｌ\t Agents  "), "owl agents");
});

test("classifies invalid, credentialed, private, and authentication targets", () => {
  const fetch = (url, content = "Ordinary content") => classifyResearchTarget({
    tool: "WebFetch", url, query: null, prompt: null, title: null, content, links: [], http_status: null, is_error: false,
  });
  assert.equal(fetch("file:///etc/passwd").ok, false);
  assert.equal(fetch("https://user:pw@example.test/docs").reason, "credential_url");
  assert.equal(fetch("https://example.test/?token=fake-token-value").reason, "credential_url");
  assert.equal(fetch("https://example.test/?X-Amz-Signature=fake-signature").reason, "credential_url");
  assert.equal(fetch("https://example.test/oauth?code=fake-code&state=fake-state").reason, "credential_url");
  assert.equal(fetch("https://localhost/docs").reason, "private_host");
  assert.equal(fetch("https://foo.local/docs").reason, "private_host");
  assert.equal(fetch("https://intranet/docs").reason, "private_host");
  assert.equal(fetch("https://10.0.0.1/docs").reason, "private_host");
  assert.equal(fetch("https://172.20.1.1/docs").reason, "private_host");
  assert.equal(fetch("https://192.168.1.1/docs").reason, "private_host");
  assert.equal(fetch("https://127.0.0.1/docs").reason, "private_host");
  assert.equal(fetch("https://169.254.1.1/docs").reason, "private_host");
  assert.equal(fetch("https://100.64.0.1/docs").reason, "private_host");
  assert.equal(fetch("https://[::1]/docs").reason, "private_host");
  assert.equal(fetch("https://[fd00::1]/docs").reason, "private_host");
  assert.equal(fetch("https://[fe80::1]/docs").reason, "private_host");
  assert.equal(fetch("https://[::ffff:192.168.0.1]/docs").reason, "private_host");
  assert.equal(fetch("https://example.test/oauth/authorize").reason, "auth_page");
  assert.equal(fetch("https://accounts.example.test/").reason, "auth_page");
  assert.equal(fetch("https://x.okta.com/docs").reason, "auth_page");
  assert.equal(fetch("https://example.test/page", "Sign in with your password").reason, "auth_page");
  assert.equal(fetch("https://172.32.0.1/docs").ok, true);
  assert.equal(fetch("https://example.test/authors").ok, true);
});

test("recognizes private hosts and filters search links", () => {
  assert.equal(isPrivateResearchHost("172.20.1.1"), true);
  assert.equal(isPrivateResearchHost("172.32.0.1"), false);
  assert.deepEqual(filterResearchLinks([
    { title: "Public", url: "http://example.test/guide#top" },
    { title: "Private", url: "http://192.168.1.2/private" },
    { title: "Duplicate", url: "https://example.test/guide" },
  ]), [{ title: "Public", url: "https://example.test/guide" }]);
});

test("redacts credentials, token forms, PEM blocks, webhook URLs, and userinfo", () => {
  const secret = "sk-ant-fakefakefakefakefakefake";
  const input = `password: fake-password-value Authorization: Bearer fake-bearer-value bearer: fake-key-value ${secret} sk-fakefakefakefakefakefake sk_live_fakefakefakefakefake rk_live_fakefakefakefakefake ghp_fakefakefakefakefakefake gho_fakefakefakefakefakefake ghu_fakefakefakefakefakefake ghs_fakefakefakefakefakefake ghr_fakefakefakefakefakefake github_pat_fakefakefakefakefakefake xoxb-fake-fake-fake-fake xapp-fake-fake-fake-fake AKIA1234567890ABCDEF ASIA1234567890ABCDEF AIza12345678901234567890123456789012345 ya29.fakefakefakefakefake eyJabcdefghij.abcdefghij.abcdefghij npm_fakefakefakefake glpat-fakefakefakefake -----BEGIN RSA PRIVATE KEY----- fake-key-data -----END RSA PRIVATE KEY----- https://user:pass@example.test/x https://hooks.slack.com/services/Tfake/Bfake/fake https://discord.com/api/webhooks/fake/fake`;
  const result = redactResearchText(input);
  assert.ok(result.redactions >= 5);
  assert.ok(result.redacted_chars > 0);
  assert.doesNotMatch(result.text, /fake-password-value|fake-bearer-value|fake-key-value|sk-ant-fake|github_pat_fake|AKIA1234567890ABCDEF|ASIA1234567890ABCDEF|AIza12345678901234567890123456789012345|ya29\.fake|eyJabcdefghij|npm_fake|glpat-fake|fake-key-data|user:pass|hooks\.slack\.com\/services\/Tfake|discord\.com\/api\/webhooks\/fake/u);
  assert.match(result.text, /\[REDACTED\]/u);
  assert.deepEqual(redactResearchText("Authorization: Bearer fake-header-value"), {
    text: "Authorization: [REDACTED]",
    redactions: 1,
    redacted_chars: "fake-header-value".length,
  });
});

test("detects authentication headers and short login pages", () => {
  assert.equal(looksLikeLoginPage("Sign in\nPassword"), true);
  assert.equal(looksLikeLoginPage("x".repeat(2001) + " sign in password"), false);
  assert.equal(classifyResearchTarget({
    tool: "WebFetch", url: "https://example.test/docs", query: null, prompt: null, title: null, content: "x".repeat(50),
    links: [], http_status: null, is_error: false, has_auth_headers: true,
  }).reason, "auth_page");
});

test("detects long login forms without excluding ordinary technical articles", () => {
  const loginContent = `<form><h1>Sign in</h1><label>Password</label><input type="password"></form>${"x".repeat(3000)}`;
  assert.ok(loginContent.length > 3000);
  assert.equal(classifyResearchTarget({
    tool: "WebFetch", url: "https://example.test/account", query: null, prompt: null, title: null, content: loginContent,
    links: [], http_status: null, is_error: false,
  }).reason, "auth_page");

  const article = Array.from({ length: 40 }, () =>
    "This technical guide explains password hashing and salted digests. Elsewhere, users can sign in to the dashboard after an administrator provisions an account.",
  ).join(" ");
  assert.ok(article.length > 3000);
  assert.equal(classifyResearchTarget({
    tool: "WebFetch", url: "https://example.test/guide", query: null, prompt: null, title: null, content: article,
    links: [], http_status: null, is_error: false,
  }).ok, true);
});

test("detects password forms after the first 5,000 characters", () => {
  const content = `${"x".repeat(5_001)}<input type="password">`;
  assert.equal(classifyResearchTarget({
    tool: "WebFetch", url: "https://example.test/account", query: null, prompt: null, title: null, content,
    links: [], http_status: null, is_error: false,
  }).reason, "auth_page");
});

test("detects current-password autocomplete after the first 5,000 characters", () => {
  const content = `${"x".repeat(5_001)}<input autocomplete="current-password">`;
  assert.equal(classifyResearchTarget({
    tool: "WebFetch", url: "https://example.test/account", query: null, prompt: null, title: null, content,
    links: [], http_status: null, is_error: false,
  }).reason, "auth_page");
});

test("keeps a long ordinary article without a password form", () => {
  const loginContent = `${"x".repeat(5_001)}<input type="password">`;
  const article = "Technical article text. ".repeat(Math.ceil(loginContent.length / "Technical article text. ".length)).slice(0, loginContent.length);
  assert.equal(article.length, loginContent.length);
  assert.equal(classifyResearchTarget({
    tool: "WebFetch", url: "https://example.test/guide", query: null, prompt: null, title: null, content: article,
    links: [], http_status: null, is_error: false,
  }).ok, true);
});
