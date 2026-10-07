import { integrationVerificationView, planWarningLines } from '../lib/work-assurance.mjs';
import type { TFunction } from '@/lib/i18n';
import type { WorkAssurance } from '@/lib/types';

interface WorkAssurancePanelProps {
  assurance: WorkAssurance | null;
  t: TFunction;
}

/** The Work's integration verification result and plan quality warnings. Hidden when neither was recorded. */
export function WorkAssurancePanel({ assurance, t }: WorkAssurancePanelProps) {
  const verification = integrationVerificationView(assurance);
  const warnings = planWarningLines(assurance);
  if (!verification && warnings.length === 0) return null;
  return (
    <section className="panel" aria-labelledby="sec-assurance">
      <h2 className="panel__title" id="sec-assurance">
        {t('work.assuranceTitle')}
      </h2>
      {verification && (
        <div className="row">
          <div className="row__main">
            <div className="row__title">{t('work.integrationVerification')}</div>
            <div className="row__sub">
              {t('work.integrationStatus', { status: verification.status })}
              {verification.reason ? ` · ${verification.reason}` : ''}
            </div>
            {verification.failedCommand && (
              <div className="row__sub">{t('work.integrationFailedCommand', { command: verification.failedCommand })}</div>
            )}
            {verification.message && <div className="row__sub">{verification.message}</div>}
          </div>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="list">
          <div className="row__title">
            {t('work.planWarnings')} <span className="count">{warnings.length}</span>
          </div>
          {warnings.map((warning, index) => (
            <div className="row" key={`${index}:${warning.title}`}>
              <div className="row__main">
                <div className="row__title">{warning.title}</div>
                <div className="row__sub">{warning.detail}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
