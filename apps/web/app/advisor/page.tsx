import { Suspense } from 'react';
import { AdvisorWindowsView } from '@/components/AdvisorWindowsView';

export default function AdvisorPage() {
  return (
    <div className="advisor-page-wrap">
      <Suspense fallback={null}>
        <AdvisorWindowsView />
      </Suspense>
    </div>
  );
}
