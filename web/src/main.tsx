import './index.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyLocale, storedLocale } from './lib/i18n';
import { applyMode, storedMode } from './theme';

applyMode(storedMode());
applyLocale(storedLocale());

createRoot(document.getElementById('root')!).render(<App />);
