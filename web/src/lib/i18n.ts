/**
 * Translation core: catalogs, lookup, interpolation, plurals and Intl
 * formatters. Free of Svelte runes and browser globals so plain helpers
 * (lib/bambu.ts, lib/history.ts) and the node tests can use it; the reactive
 * locale lives in i18n.svelte.ts, which plugs itself in with setLocaleSource().
 */
import { en, type MessageKey, type Messages, type PluralMessage } from '../locales/en.ts';
import { fr } from '../locales/fr.ts';

export type { MessageKey } from '../locales/en.ts';

export const CATALOGS = { en, fr } satisfies Record<string, Messages>;
export type Locale = keyof typeof CATALOGS;
export const LOCALES = Object.keys(CATALOGS) as Locale[];
/** Language names, each in its own language (not translated). */
export const LOCALE_NAMES: Record<Locale, string> = { en: 'English', fr: 'Français' };

export const isLocale = (v: unknown): v is Locale => typeof v === 'string' && v in CATALOGS;

/** Saved choice first, then the first browser language we support, then English. */
export function detectLocale(saved: string | null | undefined, languages: readonly string[] = []): Locale {
  if (isLocale(saved)) return saved;
  for (const lang of languages) {
    const base = lang.toLowerCase().split('-')[0];
    if (isLocale(base)) return base;
  }
  return 'en';
}

let source: () => Locale = () => 'en';

/** Where the current locale comes from (a reactive getter in the browser). */
export function setLocaleSource(get: () => Locale) {
  source = get;
}

export type Params = Record<string, string | number>;

const pluralRules = new Map<Locale, Intl.PluralRules>();

function pick(message: string | PluralMessage, locale: Locale, count: unknown): string {
  if (typeof message === 'string') return message;
  if (typeof count !== 'number') return message.other;
  let rules = pluralRules.get(locale);
  if (!rules) pluralRules.set(locale, (rules = new Intl.PluralRules(locale)));
  return message[rules.select(count)] ?? message.other;
}

/** Message for `key` in `locale`; `{name}` placeholders take `params.name` (numbers are localized). */
export function translate(locale: Locale, key: MessageKey, params?: Params): string {
  const message: string | PluralMessage | undefined = CATALOGS[locale][key] ?? en[key];
  if (message === undefined) return key;
  const text = pick(message, locale, params?.count);
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    if (value === undefined) return match;
    return typeof value === 'number' ? formatNumber(value, undefined, locale) : value;
  });
}

/** Translate in the current locale. Reactive when called from a component. */
export function t(key: MessageKey, params?: Params): string {
  return translate(source(), key, params);
}

// Intl formatters are relatively costly to build: keep one per locale + options.
const cache = new Map<string, unknown>();
function cached<T>(kind: string, locale: Locale, options: object | undefined, make: () => T): T {
  const id = `${kind}|${locale}|${options ? JSON.stringify(options) : ''}`;
  let f = cache.get(id) as T | undefined;
  if (!f) cache.set(id, (f = make()));
  return f;
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions, locale = source()) {
  return cached('n', locale, options, () => new Intl.NumberFormat(locale, options)).format(value);
}

export function formatDate(
  value: number | Date,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
  locale = source(),
) {
  return cached('d', locale, options, () => new Intl.DateTimeFormat(locale, options)).format(value);
}

function formatRelative(value: number, unit: Intl.RelativeTimeFormatUnit, locale = source()) {
  return cached('r', locale, undefined, () => new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })).format(value, unit);
}

const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 7],
  ['week', 4.35],
  ['month', 12],
  ['year', Infinity],
];

/** "5 minutes ago" / "il y a 5 minutes" for a past (or future) timestamp. */
export function formatTimeAgo(at: number, now = Date.now(), locale = source()) {
  let value = (at - now) / 1000;
  for (const [unit, size] of STEPS) {
    if (Math.abs(value) < size) return formatRelative(Math.round(value), unit, locale);
    value /= size;
  }
  return formatRelative(Math.round(value), 'year', locale);
}
