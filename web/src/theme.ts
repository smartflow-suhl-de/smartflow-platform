const MODE_KEY = 'sf.mode';

export type Mode = 'light' | 'dark';

export function storedMode(): Mode {
  try {
    const value = localStorage.getItem(MODE_KEY);
    if (value === 'light' || value === 'dark') return value;
  } catch {
    /* privater Modus */
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyMode(mode: Mode): void {
  const root = document.documentElement;
  root.classList.toggle('dark', mode === 'dark');
  root.dataset.mode = mode;
  root.style.colorScheme = mode;
  const paper = getComputedStyle(root).getPropertyValue('--color-paper').trim();
  const meta = document.querySelector('meta[name="theme-color"]');
  if (paper && meta) meta.setAttribute('content', paper);
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* privater Modus */
  }
}
