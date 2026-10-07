/** Small inline stroke icons shared across the UI. No external icon dependency. */

type IconProps = { className?: string };

export function TrashIcon({ className }: IconProps = {}) {
  return (
    <svg className={className} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 5h11" />
      <path d="M7 5V3.5h4V5" />
      <path d="M4.5 5l.6 9a1 1 0 0 0 1 1h5.8a1 1 0 0 0 1-1l.6-9" />
      <path d="M7.3 8v4.5" />
      <path d="M10.7 8v4.5" />
    </svg>
  );
}

export function ArchiveBoxIcon({ className }: IconProps = {}) {
  return (
    <svg className={className} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3.5" width="12" height="3" rx="1" />
      <path d="M4 6.5v7a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-7" />
      <path d="M7.2 9.5h3.6" />
    </svg>
  );
}

export function RestoreIcon({ className }: IconProps = {}) {
  return (
    <svg className={className} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="8.5" width="12" height="6" rx="1" />
      <path d="M9 8V2.5" />
      <path d="M6.3 4.8 9 2.2l2.7 2.6" />
    </svg>
  );
}

export function FolderIcon({ className }: IconProps = {}) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 5a1 1 0 0 1 1-1h3.3l1.3 1.6h6.4a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />
    </svg>
  );
}

export function SendIcon({ className }: IconProps = {}) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 14.5v-11" />
      <path d="M4.5 8 9 3.5 13.5 8" />
    </svg>
  );
}
