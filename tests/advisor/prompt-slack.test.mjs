import assert from "node:assert/strict";
import { test } from "node:test";

import { applyAdvisorInterfaceInstructions, buildSlackFormatInstruction } from "../../packages/shared/dist/index.js";

test("Slack Advisor turns append Slack mrkdwn and owl-actions formatting guidance", () => {
  const prompt = "Keep this exact user request.\r\n  Including spacing.  ";
  const formatted = applyAdvisorInterfaceInstructions(prompt, "slack");

  assert.ok(formatted.startsWith(prompt), "the user's prompt remains unchanged at the beginning");
  assert.match(formatted, /Slack mrkdwn/u);
  assert.match(formatted, /use \*bold\* with single asterisks, _italic_, ~strike~/u);
  assert.match(formatted, /Do not use # headings/u);
  assert.match(formatted, /• bullets/u);
  assert.match(formatted, /<url\|text> links/u);
  assert.match(formatted, /or tables/u);
  assert.match(formatted, /Code fences and inline code are allowed/u);
  assert.match(formatted, /owl-actions/u);
  assert.match(formatted, /owl-actions fence format is unchanged/u);
  assert.match(formatted, /Whenever creating a Work, still emit the required action/u);
  assert.match(formatted, /exactly one standard triple-backtick/u);
  assert.match(formatted, /valid JSON array exactly as specified elsewhere in this prompt/u);
  assert.match(formatted, /parses and strips it before display/u);
  assert.match(formatted, /never convert or reformat it/u);
});

test("non-Slack Advisor interfaces preserve the prompt byte-for-byte", () => {
  const prompt = "\tOriginal prompt\r\nwith trailing spaces.  ";

  for (const interfaceKind of ["web", "discord", "terminal", "unknown"]) {
    assert.equal(applyAdvisorInterfaceInstructions(prompt, interfaceKind), prompt);
  }
});

test("Slack formatting instruction is available as a pure shared helper", () => {
  const instruction = buildSlackFormatInstruction();
  assert.match(instruction, /mrkdwn/u);
  assert.match(instruction, /owl-actions/u);
  assert.match(instruction, /fence format is unchanged/u);
  assert.match(instruction, /Whenever creating a Work/u);
});
