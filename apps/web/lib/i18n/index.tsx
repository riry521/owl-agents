'use client';

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import jaDict from './ja.json';
import enDict from './en.json';
import { getOwnerLanguage } from '@/lib/api-client';

export type Locale = 'ja' | 'en';

const dictionaries: Record<Locale, Record<string, unknown>> = { ja: jaDict, en: enDict };

const STORAGE_KEY = 'owl-locale';

function storedLocale(): Locale | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'ja' || stored === 'en') return stored;
  } catch { /* SSR or storage blocked */ }
  return null;
}

function detectLocale(): Locale {
  const stored = storedLocale();
  if (stored) return stored;
  try {
    const lang = navigator.language;
    if (lang.startsWith('ja')) return 'ja';
    return 'en';
  } catch { /* SSR */ }
  return 'ja';
}

function getNestedValue(obj: unknown, path: string): string | undefined {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' ? current : undefined;
}

function interpolate(template: string, params?: Record<string, string>): string {
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => params[key] ?? `{{${key}}}`);
}

export type TFunction = (key: string, params?: Record<string, string>) => string;

interface LocaleContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: TFunction;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('ja');

  useEffect(() => {
    setLocaleState(detectLocale());
    // A viewer who never picked a locale sees the Owl-wide output language.
    if (storedLocale()) return;
    let alive = true;
    getOwnerLanguage()
      .then((language) => { if (alive && !storedLocale()) setLocaleState(language); })
      .catch(() => { /* not signed in or server unreachable: keep the browser language */ });
    return () => {
      alive = false;
    };
  }, []);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* noop */ }
    try { document.documentElement.lang = next; } catch { /* noop */ }
  }, []);

  useEffect(() => {
    try { document.documentElement.lang = locale; } catch { /* noop */ }
  }, [locale]);

  const t: TFunction = useCallback((key: string, params?: Record<string, string>) => {
    const value = getNestedValue(dictionaries[locale], key);
    if (value !== undefined) return interpolate(value, params);
    // Fallback to Japanese
    const fallback = getNestedValue(dictionaries.ja, key);
    if (fallback !== undefined) return interpolate(fallback, params);
    return key;
  }, [locale]);

  return (
    <LocaleContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error('useLocale must be used within a LocaleProvider');
  return ctx;
}
