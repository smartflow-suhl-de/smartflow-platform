import { getCollection, type CollectionEntry } from 'astro:content';

export type SitePage = CollectionEntry<'pages'>;

/** `index.md` is the home page; every other id is a nested route. */
export function hrefOf(entry: SitePage): string {
  if (entry.id === 'index') return '/';
  return `/${entry.id.replace(/\/index$/, '')}/`;
}

export async function loadPages(): Promise<SitePage[]> {
  const entries = await getCollection('pages');
  return entries.sort(
    (a, b) => (a.data.order ?? 0) - (b.data.order ?? 0) || a.id.localeCompare(b.id),
  );
}

export function navOf(pages: SitePage[]): Array<{ href: string; title: string }> {
  return pages
    .filter((entry) => entry.id !== 'index')
    .map((entry) => ({ href: hrefOf(entry), title: entry.data.title }));
}