import { Card, CardHeader, PageHeader } from '../components/ui';
import type { Messages } from '../lib/i18n';
import { AppLink } from '../lib/router';

export function HelpPage({ messages }: { messages: Messages }) {
  return (
    <div>
      <PageHeader title={messages.helpPage.title} description={messages.helpPage.description} />

      <div className="sf-settings-grid">
        <Card>
          <CardHeader title={messages.helpPage.searchTitle} />
          <div className="sf-card-body">
            <p className="sf-card-text">{messages.helpPage.searchText}</p>
          </div>
        </Card>

        <Card>
          <CardHeader title={messages.helpPage.navTitle} />
          <div className="sf-card-body">
            <p className="sf-card-text">{messages.helpPage.navText}</p>
          </div>
        </Card>

        <Card>
          <CardHeader title={messages.helpPage.displayTitle} />
          <div className="sf-card-body">
            <p className="sf-card-text">{messages.helpPage.displayText}</p>
          </div>
          <div className="sf-card-foot">
            <AppLink to="/settings" className="sf-text-link">
              {messages.helpPage.settingsLink}
            </AppLink>
          </div>
        </Card>

        <Card>
          <CardHeader title={messages.helpPage.apiTitle} />
          <div className="sf-card-body">
            <p className="sf-card-text">{messages.helpPage.apiText}</p>
          </div>
          <div className="sf-card-foot">
            <a href="/api/openapi.json" target="_blank" rel="noreferrer" className="sf-text-link">
              {messages.helpPage.openApiLink}
            </a>
          </div>
        </Card>
      </div>
    </div>
  );
}
