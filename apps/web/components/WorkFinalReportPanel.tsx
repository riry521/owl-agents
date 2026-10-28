import { formatDateTime } from '@/lib/format';
import type { Locale, TFunction } from '@/lib/i18n';
import type { WorkFinalReport } from '@/lib/types';

interface WorkFinalReportPanelProps {
  state: string;
  finalReport: WorkFinalReport | null | undefined;
  locale: Locale;
  t: TFunction;
}

/** The Manager's closing report of a completed Work, split into three sections. Hidden unless completed with a report. */
export function WorkFinalReportPanel({ state, finalReport, locale, t }: WorkFinalReportPanelProps) {
  if (state !== 'completed' || !finalReport) return null;
  const sections = [
    { key: 'summary', title: t('work.finalReportSummary'), text: finalReport.summary },
    { key: 'tests', title: t('work.finalReportTests'), text: finalReport.test_results },
    { key: 'issues', title: t('work.finalReportIssues'), text: finalReport.issues },
  ].filter((section) => section.text.trim() !== '');
  if (sections.length === 0) return null;
  return (
    <section className="panel final-report" aria-labelledby="sec-final-report">
      <div className="final-report__head">
        <h2 className="panel__title final-report__title" id="sec-final-report">
          {t('work.finalReport')}
        </h2>
        <p className="final-report__meta">{t('work.finalReportMeta', { at: formatDateTime(finalReport.created_at, locale) })}</p>
      </div>
      {sections.map((section) => (
        <div key={section.key}>
          <h3 className="final-report__heading">{section.title}</h3>
          <p className="final-report__text">{section.text}</p>
        </div>
      ))}
    </section>
  );
}
