'use client';

import type { FileDiff } from '@/lib/skill-diff';
import type { TFunction } from '@/lib/i18n';

/** One file's line diff, with a "+added −removed" summary header. */
export function SkillFileDiff({ diff, t, headClassName }: { diff: FileDiff; t: TFunction; headClassName: string }) {
  return (
    <>
      <div className={headClassName}>
        {diff.lines === null
          ? diff.path
          : t('skills.history.diffSummary', { path: diff.path, added: String(diff.added), removed: String(diff.removed) })}
      </div>
      {diff.lines === null ? (
        <p className="note">{t('skills.diffTooLarge')}</p>
      ) : (
        <div className="diff">
          {diff.lines.map((line, i) => (
            <div
              key={i}
              className={`diff__row${line.kind === 'added' ? ' diff__row--added' : line.kind === 'removed' ? ' diff__row--removed' : ''}`}
            >
              <span className="diff__gutter">{line.oldLineNo ?? ''}</span>
              <span className="diff__gutter">{line.newLineNo ?? ''}</span>
              <span className="diff__sign">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ''}</span>
              <span className="diff__text">{line.text}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
