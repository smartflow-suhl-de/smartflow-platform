import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { FakeNode, browser } from './helpers/browser.ts';

/**
 * The focus trap is driven by a handful of pure helpers so it can be tested
 * without a DOM: which children count as focusable, where Tab goes, which
 * element receives focus on open, and whether focus may return. The hook itself
 * only wires them to events.
 */
const { focusInitial, focusableIn, nextFocusTarget, restoreFocus } =
  await import('../src/components/useFocusTrap.ts');

/** A dialog with one dismiss button, one input and one confirm button. */
function dialogTree(): { dialog: FakeNode; close: FakeNode; input: FakeNode; confirm: FakeNode } {
  const close = new FakeNode('button');
  const input = new FakeNode('input');
  const confirm = new FakeNode('button');
  const dialog = new FakeNode('div').append(close, input, confirm);
  return { dialog, close, input, confirm };
}

describe('focusableIn', () => {
  it('lists the focusable children in document order', () => {
    const { dialog, close, input, confirm } = dialogTree();
    assert.deepEqual(focusableIn(dialog as never), [close, input, confirm] as never);
  });

  it('skips a disabled button and a hidden node', () => {
    const enabled = new FakeNode('button');
    const disabled = new FakeNode('button');
    disabled.setAttribute('disabled', '');
    const hidden = new FakeNode('button');
    hidden.getClientRects = () => [];
    const dialog = new FakeNode('div').append(enabled, disabled, hidden);

    assert.deepEqual(focusableIn(dialog as never), [enabled] as never);
  });

  it('accepts a link only with an href', () => {
    const link = new FakeNode('a');
    link.setAttribute('href', '/help');
    const anchorWithoutHref = new FakeNode('a');
    const dialog = new FakeNode('div').append(link, anchorWithoutHref);

    assert.deepEqual(focusableIn(dialog as never), [link] as never);
  });
});

describe('nextFocusTarget', () => {
  it('moves from the last element to the first on Tab', () => {
    const { dialog, close, confirm } = dialogTree();
    assert.equal(nextFocusTarget(dialog as never, confirm as never, false), close);
  });

  it('moves from the first element to the last on Shift+Tab', () => {
    const { dialog, close, confirm } = dialogTree();
    assert.equal(nextFocusTarget(dialog as never, close as never, true), confirm);
  });

  it('leaves an interior move to the browser', () => {
    const { dialog, input } = dialogTree();
    assert.equal(nextFocusTarget(dialog as never, input as never, false), null);
    assert.equal(nextFocusTarget(dialog as never, input as never, true), null);
  });

  it('pulls focus back in when it already escaped the overlay', () => {
    const { dialog, close, confirm } = dialogTree();
    const outside = new FakeNode('button');

    // Click on the backdrop, then Tab: without this the next stop is the
    // sidebar behind the modal.
    assert.equal(nextFocusTarget(dialog as never, outside as never, false), close);
    assert.equal(nextFocusTarget(dialog as never, null, true), confirm);
  });

  it('falls back to the container itself when nothing inside is focusable', () => {
    const empty = new FakeNode('div');
    assert.equal(nextFocusTarget(empty as never, null, false), empty);
  });
});

describe('focusInitial', () => {
  beforeEach(() => {
    browser.reset();
  });

  it('uses the preferred element when it accepts focus', () => {
    const { dialog, input } = dialogTree();
    focusInitial(dialog as never, input as never);

    assert.equal(document.activeElement, input);
  });

  it('falls back to the first focusable child when the preference is disabled', () => {
    // Re-opened confirm dialog while the request is in flight: cancel is
    // disabled, so the preferred element would silently keep focus outside.
    const cancel = new FakeNode('button');
    cancel.setAttribute('disabled', '');
    const confirm = new FakeNode('button');
    const dialog = new FakeNode('div').append(cancel, confirm);

    focusInitial(dialog as never, cancel as never);
    assert.equal(document.activeElement, confirm);
  });

  it('holds focus on the container when nothing inside is focusable', () => {
    const empty = new FakeNode('div');
    focusInitial(empty as never, null);

    assert.equal(document.activeElement, empty);
  });
});

describe('restoreFocus', () => {
  beforeEach(() => {
    browser.reset();
  });

  it('returns focus to an element still in the document', () => {
    const opener = new FakeNode('button');
    browser.documentRoot.append(opener);

    let focused = 0;
    opener.onFocus(() => {
      focused += 1;
    });

    restoreFocus(opener as never);
    assert.equal(focused, 1);
    assert.equal(document.activeElement, opener);
  });

  it('leaves focus alone when the opener left the document', () => {
    // A table row replaced by an API refresh while the dialog was open.
    const detached = new FakeNode('button');
    let focused = 0;
    detached.onFocus(() => {
      focused += 1;
    });

    restoreFocus(detached as never);
    assert.equal(focused, 0);
  });

  it('tolerates a null opener', () => {
    assert.doesNotThrow(() => restoreFocus(null));
  });
});
