import { createHash } from "node:crypto";

/**
 * A valid clipping page (the only template a test can write without a project or a Work) whose title and
 * point list carry `text`. Put it under `research/`; tests that only need some searchable file use it.
 */
export function clippingText(title, text, { projectIds = [] } = {}) {
  const id = `01${createHash("sha1").update(title).digest("hex").toUpperCase().replace(/[^0-9A-HJKMNP-TV-Z]/gu, "0").slice(0, 24).padEnd(24, "0")}`;
  const projects = projectIds.length > 0 ? `project_ids: [${projectIds.join(", ")}]\n` : "";
  return `---
id: ${id}
type: clipping
title: ${title}
source_url: https://example.com/${encodeURIComponent(title)}
retrieved_at: 2026-10-01T05:00:00Z
retrieved_by: research-recorder
${projects}summary: ${text}
tags: [sample]
created: 2026-10-01
---
# ${title}

## 出典
- URL: https://example.com/${encodeURIComponent(title)}
- 取得: 2026-10-01（research-recorder）

## 要点
- ${text}

## 関係する Project
- （なし）
`;
}
