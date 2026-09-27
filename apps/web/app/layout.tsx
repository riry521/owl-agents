import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { NavBar } from '@/components/NavBar';
import { ProviderPauseBanner } from '@/components/ProviderPauseBanner';
import { RemovalErrorToast } from '@/components/RemovalErrorToast';
import { LocaleProvider } from '@/lib/i18n';
import './globals.css';

export const metadata: Metadata = {
  title: 'Owl-Agent',
  description: 'Multi-agent orchestration board',
  icons: {
    icon: [
      { url: '/owl/favicon.ico', sizes: '16x16 32x32 48x48' },
      { url: '/owl/icon.png', sizes: '512x512', type: 'image/png' },
      { url: '/owl/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: [{ url: '/owl/apple-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  manifest: '/owl/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Owl-Agent',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <LocaleProvider>
          <NavBar />
          <ProviderPauseBanner />
          <main className="page">{children}</main>
          <RemovalErrorToast />
        </LocaleProvider>
      </body>
    </html>
  );
}
