import { Suspense } from 'react';
import { SkillHistoryView } from '@/components/SkillHistoryView';

/** Static route; the skill name comes from `?name=` (read client-side via useSearchParams). */
export default function SkillHistoryPage() {
  return (
    <Suspense fallback={<p className="empty">読み込み中…</p>}>
      <SkillHistoryView />
    </Suspense>
  );
}
