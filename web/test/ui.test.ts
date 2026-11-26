import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement, type ReactElement } from 'react';

const { Field, Input } = await import('../src/components/ui.tsx');

interface FieldTree {
  hint: { id?: string } | null;
  error: { id?: string } | null;
  control: { id?: string; 'aria-describedby'?: string };
}

/**
 * `Field` uses no hooks, so the component is called directly and the returned
 * element tree is inspected instead of rendering it (the setup has no DOM).
 */
function fieldTree(htmlFor: string | undefined, hint?: string, error?: string): FieldTree {
  const field = Field({
    label: 'Feld',
    hint,
    error,
    htmlFor,
    children: createElement(Input, { id: htmlFor, invalid: Boolean(error) }),
  }) as unknown as ReactElement<{
    children: [
      ReactElement<{ children: [ReactElement, ReactElement<{ id?: string }> | null] }>,
      ReactElement<{ id?: string; 'aria-describedby'?: string }>,
      ReactElement<{ id?: string }> | null,
    ];
  }>;

  const [labelRow, control, errorNode] = field.props.children;
  const hintNode = labelRow.props.children[1];
  return {
    hint: hintNode ? hintNode.props : null,
    error: errorNode ? errorNode.props : null,
    control: control.props,
  };
}

describe('Field description wiring', () => {
  it('points the control at the hint when only a hint exists', () => {
    const tree = fieldTree('sf-x', 'Pflichtfeld');

    assert.equal(tree.control['aria-describedby'], 'sf-x-hint');
    assert.equal(tree.hint?.id, 'sf-x-hint');
    assert.equal(tree.error, null);
  });

  it('points the control at the error when only an error exists', () => {
    const tree = fieldTree('sf-x', undefined, 'Bitte ausfüllen');

    assert.equal(tree.control['aria-describedby'], 'sf-x-error');
    assert.equal(tree.error?.id, 'sf-x-error');
    assert.equal(tree.hint, null);
  });

  it('announces hint and error in that order', () => {
    const tree = fieldTree('sf-x', 'Pflichtfeld', 'Bitte ausfüllen');

    assert.equal(tree.control['aria-describedby'], 'sf-x-hint sf-x-error');
    assert.equal(tree.hint?.id, 'sf-x-hint');
    assert.equal(tree.error?.id, 'sf-x-error');
  });

  it('sets no reference when there is no text to point at', () => {
    const tree = fieldTree('sf-x');

    assert.equal(tree.control['aria-describedby'], undefined);
  });

  it('sets no reference without a control id', () => {
    const tree = fieldTree(undefined, 'Pflichtfeld', 'Bitte ausfüllen');

    assert.equal(tree.control['aria-describedby'], undefined);
  });
});
