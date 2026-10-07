import { Suspense } from 'react';
import { WorkDetailView } from '@/components/WorkDetailView';

/** Static route; the Work id comes from `?id=` (read client-side via useSearchParams). */
export default function WorkPage() {
  return (
    <Suspense fallback={<p className="empty">読み込み中…</p>}>
      <WorkDetailView />
    </Suspense>
  );
}
