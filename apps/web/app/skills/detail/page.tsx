import { Suspense } from 'react';
import { SkillDetailView } from '@/components/SkillDetailView';

/** Static route; the skill name comes from `?name=` (read client-side via useSearchParams). */
export default function SkillDetailPage() {
  return (
    <Suspense fallback={<p className="empty">読み込み中…</p>}>
      <SkillDetailView />
    </Suspense>
  );
}
