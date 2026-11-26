import { CompassIcon } from '../components/icons';
import { Button, Card, EmptyState } from '../components/ui';
import type { Messages } from '../lib/i18n';
import { navigate } from '../lib/router';

export function NotFoundPage({ messages }: { messages: Messages }) {
  return (
    <Card>
      <EmptyState
        icon={<CompassIcon size={17} />}
        title={messages.notFound.title}
        description={messages.notFound.description}
        action={
          <Button variant="primary" onClick={() => navigate('/')}>
            {messages.notFound.back}
          </Button>
        }
      />
    </Card>
  );
}
