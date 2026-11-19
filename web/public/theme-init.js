// Apply the saved theme before first paint to avoid a flash. Loaded as a
// regular (blocking) script so the CSP can forbid inline scripts.
try {
  const t = localStorage.getItem('theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch {}
