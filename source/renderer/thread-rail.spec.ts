import test from 'ava';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AppShell} from '@/renderer/app-shell';
import {ThreadRail} from '@/renderer/thread-rail';
import type {ThreadInfo} from '@/shared/ipc';

const thread: ThreadInfo = {
	id: 'fixture-thread',
	projectId: 'fixture-project',
	nanocoderSessionId: null,
	title: 'fixture thread',
	archiveState: 'active',
	runState: 'ready',
	lastActivityAt: new Date(2026, 9, 29, 12).toISOString(),
	sessionCwd: '/fixture/project',
	mode: 'normal',
	viewOnlyReason: null,
};
const props: Parameters<typeof ThreadRail>[0] = {
	projectId: thread.projectId,
	threads: [thread],
	activeThreadId: thread.id,
	pending: false,
	now: new Date(2026, 9, 29, 13),
	importCount: null,
	onNew: () => {},
	onOpen: () => {},
	onOpenArchives: () => {},
	onOpenImport: () => {},
};
const render = (patch: Partial<typeof props> = {}) =>
	renderToStaticMarkup(createElement(ThreadRail, {...props, ...patch}));

test('plain-prop rail renders scoped groups selected semantics and literal titles (U.3)', t => {
	const html = render({
		threads: [
			{...thread, title: '<script>fixture</script>'},
			{...thread, id: 'running', title: 'fixture running', runState: 'running'},
			{
				...thread,
				id: 'earlier',
				lastActivityAt: new Date(2026, 9, 28).toISOString(),
			},
			{...thread, id: 'archived', archiveState: 'archived'},
			{
				...thread,
				id: 'other',
				projectId: 'other-project',
				title: 'other project fixture',
			},
		],
	});
	t.regex(
		html,
		/<h3 class="thread-group-heading"><span>today<\/span><span class="thread-group-count">2<\/span><\/h3>/,
	);
	t.regex(
		html,
		/<h3 class="thread-group-heading"><span>earlier<\/span><span class="thread-group-count">1<\/span><\/h3>/,
	);
	t.regex(html, /<span class="sidebar-link-count">1<\/span>/);
	t.true(html.includes('&lt;script&gt;fixture&lt;/script&gt;'));
	t.notRegex(html, /<script\b/i);
	t.false(html.includes('other project fixture'));
	t.true(html.includes('data-selected="true"'));
	t.true(html.includes('aria-current="true"'));
	t.false(html.includes('thread-status'));
	t.true(html.includes('aria-label="fixture running · running"'));
	t.false(html.includes('fixture archived'));
});

test('archived rows stay out of the rail; the archived link opens their dialog (CHAT-13, A-03)', t => {
	const archived = {
		...thread,
		id: 'archived',
		title: 'fixture archived',
		archiveState: 'archived' as const,
	};
	const html = render({threads: [thread, archived]});
	t.regex(
		html,
		/<button type="button" class="sidebar-link" aria-haspopup="dialog"[^>]*>[\s\S]*?archived[\s\S]*?sidebar-link-count">1</,
	);
	t.false(html.includes('fixture archived'));
	t.false(html.includes('aria-label="archived threads"'));
	t.false(html.includes('thread-archived'));
	t.false(html.includes('aria-expanded'));
});

test('import link shows its count only when import is ready for the project (A-03, B-12)', t => {
	const html = render({importCount: 2});
	t.regex(
		html,
		/<button type="button" class="sidebar-link"[^>]*>[\s\S]*?import sessions[\s\S]*?sidebar-link-count">2</,
	);
	t.false(html.includes('saved sessions'));
	t.false(render({importCount: null}).includes('import sessions'));
	t.false(
		render({projectId: null, importCount: 2}).includes('import sessions'),
	);
});

test('new thread shows its shortcut only when the shell passes one (A-21)', t => {
	t.false(render().includes('ui-key-hint'));
	const html = render({newThreadShortcut: '⌘N'});
	t.regex(html, /class="ui-key-hint"[^>]*>⌘N</);
});

test('selected row shows state and age in its meta line, others show age on the right (A-16, A-18)', t => {
	const html = render();
	t.regex(
		html,
		/<span class="thread-state-label">ready · <time[^>]*>1h<\/time><\/span>/,
	);
	const other = render({
		activeThreadId: null,
		threads: [{...thread, runState: 'failed', title: 'fixture failed'}],
	});
	t.regex(other, /<time class="thread-age"[^>]*>1h<\/time>/);
	t.false(other.includes('thread-state-label'));
});

test('rail rows only open threads; rename, archive and remove live in the header thread actions (A-15)', t => {
	const html = render({threads: [thread, {...thread, id: 'other'}]});
	t.is(html.split('class="thread-open"').length - 1, 2);
	t.false(html.includes('thread-actions'));
	t.false(html.includes('actions for'));
	t.false(html.includes('<details'));
	t.false(html.includes('remove from desktop'));
});

test('rail explains absent project and pending states instead of hiding disabled controls (U.3)', t => {
	const absent = render({projectId: null});
	t.true(absent.includes('select a project first'));
	t.false(absent.includes('fixture thread'));
	t.regex(absent, /aria-label="new thread"[^>]*disabled/);
	const pending = render({pending: true});
	t.true(pending.includes('another thread request is pending'));
	t.notRegex(pending, /<button(?![^>]*(?:disabled|sidebar-link))/);
});

test('shell accepts a plain thread child without replacing project or stream slots (U.3)', t => {
	const html = renderToStaticMarkup(
		createElement(AppShell, {
			title: 'fixture shell',
			statusBadges: 'fixture badges',
			projectRail: 'fixture projects',
			threadRail: createElement(ThreadRail, props),
			children: 'fixture stream',
		}),
	);
	t.true(html.includes('data-shell-slot="thread-rail"'));
	t.true(html.includes('fixture projects'));
	t.true(html.includes('fixture stream'));
	t.true(html.includes('aria-label="project threads"'));
	t.false(html.includes('thread list not built yet'));
});

test('CHAT-23 a thread Nanocoder may delete soon says so in its row, its name and its hint, and no other row does', t => {
	const html = render({
		threads: [thread, {...thread, id: 'safe', title: 'safe thread'}],
		retention: {
			hint: 'Nanocoder deletes chats not opened for 30 days. Open the chat to keep it.',
			byThread: new Map([
				[
					thread.id,
					{
						projectId: thread.projectId,
						threadId: thread.id,
						title: thread.title,
						idleDays: 27,
						daysLeft: 3,
					},
				],
			]),
		},
	});
	t.regex(html, /<span class="thread-retention">deleted in 3 days<\/span>/);
	t.regex(html, /aria-label="fixture thread · [^"]*, deleted in 3 days"/);
	t.regex(html, /Open the chat to keep it/);
	t.is(html.match(/thread-retention/g)?.length, 1);
	t.notRegex(html, /aria-label="safe thread[^"]*deleted/);
});
