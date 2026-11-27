/**
 * Deep links that seed a filter field.
 *
 * A `?q=` parameter is an entry point, not a second source of truth: it seeds
 * the search field once, after that the store owns the value. The caller keeps
 * the value it last applied and asks this helper again on every URL change, so
 * typing into the field is never overwritten and clearing it stays possible.
 */

/** The query-parameter value to apply now, or `null` when there is nothing new. */
export function queryParamOnce(
  search: string,
  lastApplied: string | null,
  key = 'q',
): string | null {
  let value: string | null;
  try {
    value = new URLSearchParams(search).get(key);
  } catch {
    return null;
  }
  if (value === null || value === lastApplied) return null;
  return value;
}
