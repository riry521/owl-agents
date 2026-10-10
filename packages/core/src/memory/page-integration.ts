import { parsePage, SOURCE_LABEL } from "./page-format.js";

/** The librarian model setting and the reader of `owl:new` lines. */

export interface MemoryLibrarianSetting { readonly provider: string; readonly model: string; readonly effort: string }

const NEW_MARK = new RegExp(`<!--\\s*owl:new\\s+(\\S+)(?:\\s+(${SOURCE_LABEL}))?[^>]*-->`, "u");

/** The lines of a page still carrying an `owl:new` mark, read per section from the parsed page. */
export function newLinesOf(text: string): { section: string; text: string; work_label: string | null }[] {
  const new_lines: { section: string; text: string; work_label: string | null }[] = [];
  for (const section of parsePage(text).sections) {
    for (const line of section.lines) {
      const mark = NEW_MARK.exec(line);
      if (mark) new_lines.push({ section: section.heading, text: line.replace(NEW_MARK, "").trim(), work_label: mark[2] ?? null });
    }
  }
  return new_lines;
}
