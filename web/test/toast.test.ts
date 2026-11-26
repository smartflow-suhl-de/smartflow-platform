import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { TOAST_DURATION_MS, TOAST_EXIT_MS, TOAST_LIMIT, addToast, markToastLeaving, removeToast } =
  await import('../src/lib/toast.ts');

function toast(id: number, leaving = false) {
  return { id, message: `Meldung ${id}`, tone: 'good' as const, durationMs: 1000, leaving };
}

describe('toast queue', () => {
  it('appends new toasts in arrival order', () => {
    const first = addToast([], toast(1));
    const second = addToast(first, toast(2));

    assert.deepEqual(
      second.map((item) => item.id),
      [1, 2],
    );
  });

  it('keeps only the newest toasts when the limit is reached', () => {
    let toasts: ReturnType<typeof addToast> = [];
    for (let id = 1; id <= TOAST_LIMIT + 1; id += 1) {
      toasts = addToast(toasts, toast(id));
    }

    assert.equal(toasts.length, TOAST_LIMIT);
    assert.equal(toasts[0]?.id, 2);
    assert.equal(toasts[toasts.length - 1]?.id, TOAST_LIMIT + 1);
  });

  it('marks only the requested toast as leaving', () => {
    const marked = markToastLeaving([toast(1), toast(2)], 2);

    assert.equal(marked[0]?.leaving, false);
    assert.equal(marked[1]?.leaving, true);
  });

  it('does not restart the leave state on a second close click', () => {
    const first = markToastLeaving([toast(1)], 1);
    const second = markToastLeaving(first, 1);

    assert.deepEqual(second, first);
    assert.equal(second[0]?.leaving, true);
  });

  it('ignores an unknown id instead of throwing', () => {
    const toasts = [toast(1)];
    assert.deepEqual(markToastLeaving(toasts, 99), toasts);
    assert.deepEqual(removeToast(toasts, 99), toasts);
  });

  it('removes exactly one toast after it has left', () => {
    const remaining = removeToast([toast(1), toast(2), toast(3)], 2);

    assert.deepEqual(
      remaining.map((item) => item.id),
      [1, 3],
    );
  });

  it('keeps a readable delay and matches the CSS exit duration', () => {
    assert.ok(TOAST_DURATION_MS >= 8000);
    assert.equal(TOAST_EXIT_MS, 180);
  });
});
