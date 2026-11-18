export type ThemeChoice = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'theme';

function stored(): ThemeChoice {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}

export const theme = $state({ choice: stored() });

/** "system" removes the attribute so the prefers-color-scheme media query applies. */
export function setTheme(choice: ThemeChoice) {
  theme.choice = choice;
  if (choice === 'system') {
    localStorage.removeItem(STORAGE_KEY);
    delete document.documentElement.dataset.theme;
  } else {
    localStorage.setItem(STORAGE_KEY, choice);
    document.documentElement.dataset.theme = choice;
  }
}
