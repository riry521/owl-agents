import type { CoreActivity } from '@/lib/types';
import type { TFunction } from '@/lib/i18n';
// Relative on purpose: the node component tests stub the `@/` modules.
import { commandText, elapsedParts } from '../lib/core-activity.mjs';

interface CoreActivityRowsProps {
  activities: CoreActivity[];
  workNumber: number | null;
  now: number;
  t: TFunction;
}

/** One "稼働Agent" row per thing Core is doing for the Work, styled like an agent run. */
export function CoreActivityRows({ activities, workNumber, now, t }: CoreActivityRowsProps) {
  const elapsed = (iso: string | null) => {
    const parts = iso ? elapsedParts(iso, now) : null;
    return parts ? t(`work.coreActivity.${parts.unit}`, { count: String(parts.count) }) : null;
  };
  return (
    <>
      {activities.map((a) => {
        const sinceStart = elapsed(a.started_at);
        const sinceOutput = elapsed(a.last_output_at);
        return (
          <div className="row row--running" key={a.activity_id}>
            <span className="dot dot--running" />
            <div className="row__main">
              <div className="row__title">{t('work.coreActivity.title', { kind: t(`work.coreActivity.kind.${a.kind}`) })}</div>
              <div className="row__sub">
                {[
                  workNumber === null ? null : t('work.numberLabel', { number: String(workNumber) }),
                  commandText(a.command),
                  sinceStart && t('work.coreActivity.elapsed', { elapsed: sinceStart }),
                  sinceOutput && t('work.coreActivity.lastOutput', { elapsed: sinceOutput }),
                ].filter(Boolean).join(' · ')}
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}
