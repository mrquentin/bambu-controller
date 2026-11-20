/**
 * Reactive UI language. Choice order: saved in localStorage → browser
 * languages (fr* → French) → English. See i18n.ts for lookup and formatting.
 */
import { detectLocale, isLocale, setLocaleSource, type Locale } from './i18n.ts';

export {
  LOCALES,
  LOCALE_NAMES,
  formatDate,
  formatNumber,
  formatRelative,
  formatTimeAgo,
  t,
  type Locale,
  type MessageKey,
  type Params,
} from './i18n.ts';

export type LocaleChoice = Locale | 'auto';

const STORAGE_KEY = 'locale';

function saved(): Locale | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isLocale(v) ? v : null;
  } catch {
    return null;
  }
}

const initial = saved();
export const i18n = $state<{ choice: LocaleChoice; locale: Locale }>({
  choice: initial ?? 'auto',
  locale: detectLocale(initial, navigator.languages),
});

setLocaleSource(() => i18n.locale);
document.documentElement.lang = i18n.locale;

function apply() {
  i18n.locale = detectLocale(i18n.choice === 'auto' ? null : i18n.choice, navigator.languages);
  document.documentElement.lang = i18n.locale;
}

/** "auto" forgets the saved choice and follows the browser again. */
export function setLocale(choice: LocaleChoice) {
  i18n.choice = choice;
  try {
    if (choice === 'auto') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // Private mode: the choice still applies until reload.
  }
  apply();
}

window.addEventListener('languagechange', () => {
  if (i18n.choice === 'auto') apply();
});
