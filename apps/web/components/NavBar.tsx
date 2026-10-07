'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useLocale } from '@/lib/i18n';

const LINK_DEFS: Array<{ href: string; tKey: string; match: string[] }> = [
  { href: '/board', tKey: 'nav.board', match: ['/', '/board', '/archive', '/work', '/decision'] },
  { href: '/agents', tKey: 'nav.agents', match: ['/agents'] },
  { href: '/projects', tKey: 'nav.projects', match: ['/projects'] },
  { href: '/advisor', tKey: 'nav.advisor', match: ['/advisor'] },
  { href: '/settings', tKey: 'nav.settings', match: ['/settings'] },
  { href: '/knowledge', tKey: 'nav.knowledge', match: ['/knowledge'] },
  {
    href: '/skills',
    tKey: 'nav.skills',
    match: ['/skills', '/skills/detail', '/skills/history', '/skills/approvals', '/skills/settings'],
  },
  { href: '/backlog', tKey: 'nav.backlog', match: ['/backlog'] },
  { href: '/rules', tKey: 'nav.rules', match: ['/rules', '/rules/approvals'] },
  { href: '/activity', tKey: 'nav.activity', match: ['/activity'] },
  { href: '/tokens', tKey: 'nav.tokens', match: ['/tokens'] },
];

const BOTTOM_TABS: Array<{ href: string; tKey: string; match: string[]; icon: string }> = [
  { href: '/board', tKey: 'nav.board', match: ['/', '/board', '/archive', '/work', '/decision'], icon: 'board' },
  { href: '/advisor', tKey: 'nav.advisor', match: ['/advisor'], icon: 'chat' },
  { href: '/agents', tKey: 'nav.agents', match: ['/agents'], icon: 'agents' },
  { href: '/knowledge', tKey: 'nav.knowledge', match: ['/knowledge'], icon: 'knowledge' },
  { href: '/tokens', tKey: 'nav.tokens', match: ['/tokens'], icon: 'tokens' },
];

const MORE_LINKS: Array<{ href: string; tKey: string; match: string[] }> = [
  { href: '/settings', tKey: 'nav.settings', match: ['/settings'] },
  { href: '/projects', tKey: 'nav.projects', match: ['/projects'] },
  {
    href: '/skills',
    tKey: 'nav.skills',
    match: ['/skills', '/skills/detail', '/skills/history', '/skills/approvals', '/skills/settings'],
  },
  { href: '/backlog', tKey: 'nav.backlog', match: ['/backlog'] },
  { href: '/rules', tKey: 'nav.rules', match: ['/rules', '/rules/approvals'] },
  { href: '/activity', tKey: 'nav.activity', match: ['/activity'] },
];

function TabIcon({ icon, active }: { icon: string; active: boolean }) {
  const color = active ? 'var(--accent)' : 'var(--faint)';
  switch (icon) {
    case 'board':
      return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
      );
    case 'chat':
      return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
        </svg>
      );
    case 'agents':
      return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
        </svg>
      );
    case 'knowledge':
      return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
          <path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z" />
          <path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z" />
        </svg>
      );
    case 'tokens':
      return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
          <ellipse cx="12" cy="5" rx="8" ry="3" />
          <path d="M4 5v7c0 1.66 3.58 3 8 3s8-1.34 8-3V5M4 12v7c0 1.66 3.58 3 8 3s8-1.34 8-3v-7" />
        </svg>
      );
    default:
      return null;
  }
}

export function NavBar() {
  const pathname = usePathname() ?? '/';
  const { locale, setLocale, t } = useLocale();
  const [moreOpen, setMoreOpen] = useState(false);

  const links = useMemo(
    () => LINK_DEFS.map((l) => ({ ...l, label: t(l.tKey) })),
    [t],
  );

  const isMoreActive = MORE_LINKS.some((l) => l.match.includes(pathname));

  return (
    <>
      <nav className="nav" aria-label="main">
        <Link href="/board" className="nav__brand">
          <img src="/owl/icon.png" alt="Owl" className="nav__logo" width={28} height={28} />
          OWL
        </Link>
        <div className="nav__links">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`nav__link${l.match.includes(pathname) ? ' nav__link--active' : ''}`}
            >
              {l.label}
            </Link>
          ))}
        </div>
        <button
          type="button"
          className="nav__lang"
          onClick={() => setLocale(locale === 'ja' ? 'en' : 'ja')}
          aria-label={locale === 'ja' ? 'Switch to English' : '日本語に切替'}
        >
          {t('nav.langSwitch')}
        </button>
      </nav>

      {/* Mobile bottom navigation */}
      <nav className="nav-bottom" aria-label="mobile">
        {BOTTOM_TABS.map((tab) => {
          const active = tab.match.includes(pathname);
          return (
            <Link key={tab.href} href={tab.href} className={`nav-bottom__tab${active ? ' nav-bottom__tab--active' : ''}`}>
              <TabIcon icon={tab.icon} active={active} />
              <span className="nav-bottom__label">{t(tab.tKey)}</span>
            </Link>
          );
        })}
        <button
          type="button"
          className={`nav-bottom__tab${isMoreActive ? ' nav-bottom__tab--active' : ''}`}
          onClick={() => setMoreOpen((v) => !v)}
          aria-label={t('nav.more')}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={isMoreActive ? 'var(--accent)' : 'var(--faint)'} strokeWidth="2">
            <circle cx="12" cy="12" r="1" />
            <circle cx="19" cy="12" r="1" />
            <circle cx="5" cy="12" r="1" />
          </svg>
          <span className="nav-bottom__label">{t('nav.more')}</span>
        </button>
      </nav>

      {/* More menu overlay */}
      {moreOpen && (
        <div className="nav-more-overlay" onClick={() => setMoreOpen(false)}>
          <div className="nav-more-sheet" onClick={(e) => e.stopPropagation()}>
            {MORE_LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={`nav-more-sheet__link${l.match.includes(pathname) ? ' nav-more-sheet__link--active' : ''}`}
                onClick={() => setMoreOpen(false)}
              >
                {t(l.tKey)}
              </Link>
            ))}
            <button
              type="button"
              className="nav-more-sheet__link"
              onClick={() => { setLocale(locale === 'ja' ? 'en' : 'ja'); setMoreOpen(false); }}
            >
              {locale === 'ja' ? 'English' : '日本語'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
