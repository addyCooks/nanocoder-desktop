import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {App} from '@/renderer/app';
import '@/renderer/styles/recovery-tools.css';
import '@xterm/xterm/css/xterm.css';
import '@/renderer/styles/foundations.css';
import '@/renderer/styles/app-shell.css';
import '@/renderer/styles/approvals.css';
import '@/renderer/styles/technical-gate.css';
import '@/renderer/styles/composer.css';
import '@/renderer/styles/conversation-stream.css';
import '@/renderer/styles/overlays.css';
import '@/renderer/styles/projects.css';
import '@/renderer/styles/threads.css';
import '@/renderer/styles/panels.css';
import '@/renderer/styles/files.css';
import '@/renderer/styles/projects-dialog.css';
import '@/renderer/styles/runtime-dialogs.css';
import '@/renderer/styles/terminal.css';
import '@/renderer/styles/browser.css';

const root = document.getElementById('root');
if (!root) {
	throw new Error('Missing #root element');
}

createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
