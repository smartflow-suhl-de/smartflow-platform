import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it } from 'node:test';
import './helpers/browser.ts';

const { AgentPage, AnswerBody } = await import('../src/pages/Agent.tsx');
const { ToastProvider } = await import('../src/components/Toast.tsx');
const { getMessages } = await import('../src/lib/i18n.ts');

/** The page shows toasts, so it needs the provider AppShell gives it in the app. */
function renderPage(locale: 'de' | 'en'): string {
  return renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(AgentPage, { locale, messages: getMessages(locale) }),
    ),
  );
}

describe('agent page', () => {
  it('renders the title, the composer and three examples', () => {
    const html = renderPage('de');

    assert.ok(html.includes('Agent'));
    assert.ok(html.includes('Frag die Plattform'));
    assert.equal((html.match(/sf-agent-example(?![-\w])/g) ?? []).length, 3);
    assert.ok(html.includes('Wie viele Mandanten sind gesperrt?'));
    assert.ok(html.includes('Was ist zuletzt passiert?'));
    assert.ok(html.includes('Welche Daten kann ich fragen?'));
  });

  it('does not claim the agent is ready before the status answered', () => {
    const html = renderPage('de');

    assert.ok(html.includes('disabled'), 'the composer waits for the status');
    assert.ok(!html.includes('Bereit'), 'no ready badge without a provider answer');
  });

  it('keeps the stored history behind a button instead of loading it into the thread', () => {
    const html = renderPage('de');

    assert.ok(html.includes('sf-agent-empty'), 'the chat is the main window');
    assert.ok(!html.includes('sf-agent-history'), 'the history panel stays closed');
    assert.ok(html.includes('>Verlauf<'), 'the header offers the history button');
  });

  it('renders the English example set for the English locale', () => {
    const html = renderPage('en');

    assert.ok(html.includes('How many tenants are suspended?'));
    assert.ok(html.includes('What can I ask about?'));
  });
});

describe('answer text', () => {
  it('keeps paragraphs and turns bullet lines into a list', () => {
    const html = renderToStaticMarkup(
      createElement(AnswerBody, { text: 'Zwei sind gesperrt.\n\n- Nordwind\n- Tannwerk' }),
    );

    assert.ok(html.includes('<p>Zwei sind gesperrt.</p>'));
    assert.ok(html.includes('<ul><li>Nordwind</li><li>Tannwerk</li></ul>'));
  });

  it('escapes model text instead of rendering it as HTML', () => {
    const html = renderToStaticMarkup(
      createElement(AnswerBody, { text: '<img src=x onerror=alert(1)>' }),
    );

    assert.ok(!html.includes('<img'));
    assert.ok(html.includes('&lt;img'));
  });

  it('joins wrapped lines into one paragraph and keeps blank lines apart', () => {
    const html = renderToStaticMarkup(
      createElement(AnswerBody, { text: 'Zeile eins\nZeile zwei\n\nNeuer Absatz' }),
    );

    assert.equal((html.match(/<p>/g) ?? []).length, 2);
    assert.ok(html.includes('Zeile eins Zeile zwei'));
  });
});
