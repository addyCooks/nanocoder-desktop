import test from 'ava';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AppShell} from '@/renderer/app-shell';

test('shell slots preserve plain child components without extra controls', t => {
	const html = renderToStaticMarkup(
		createElement(AppShell, {
			title: 'Nanocoder',
			statusBadges: createElement('span', null, 'idle'),
			projectRail: createElement('article', null, 'recent project fixture'),
			streamTools: createElement('section', null, 'diagnostics fixture'),
			composer: createElement('form', null, 'composer fixture'),
			children: createElement('ol', null, 'transcript fixture'),
		}),
	);
	for (const text of [
		'recent project fixture',
		'diagnostics fixture',
		'composer fixture',
		'transcript fixture',
	])
		t.true(html.includes(text));
	t.true(html.includes('data-shell-slot="project-rail"'));
	t.true(html.includes('data-shell-slot="stream-tools"'));
	t.false(html.includes('project list not built yet'));
	t.false(html.includes('thread list not built yet'));
	t.false(html.includes('<button'));
});

test('unused later shell slots render no placeholders or pretend actions', t => {
	const html = renderToStaticMarkup(
		createElement(AppShell, {
			title: 'Nanocoder',
			statusBadges: null,
			children: null,
		}),
	);
	for (const label of [
		'session tabs · not built yet',
		'project list not built yet',
		'files and review are not built yet',
		'palette not built yet',
	])
		t.false(html.includes(label));
	t.false(html.includes('class="shell-placeholder'));
	t.false(html.includes('role="tab"'));
	t.false(html.includes('bottom-panel'));
});

test('header shows the thread identity, and the thread actions button only when wired', t => {
	const thread = renderToStaticMarkup(
		createElement(AppShell, {
			title: 'Nanocoder',
			projectName: 'tide',
			threadTitle: 'fixture thread',
			children: null,
		}),
	);
	t.true(thread.includes('<p class="shell-breadcrumb">tide</p>'));
	t.true(thread.includes('fixture thread'));
	t.false(thread.includes('aria-label="thread actions"'));
	const wired = renderToStaticMarkup(
		createElement(AppShell, {
			title: 'Nanocoder',
			threadTitle: 'fixture thread',
			onOpenThreadMenu() {},
			children: null,
		}),
	);
	t.true(wired.includes('aria-label="thread actions"'));
	t.true(wired.includes('aria-haspopup="dialog"'));
	const welcome = renderToStaticMarkup(
		createElement(AppShell, {title: 'Nanocoder', children: null}),
	);
	t.true(welcome.includes('local workspace'));
	t.true(welcome.includes('your projects'));
	t.false(welcome.includes('thread actions'));
});

test('composer placement defaults to the bottom and passes the centred state through', t => {
	const bottom = renderToStaticMarkup(
		createElement(AppShell, {title: 'Nanocoder', children: null}),
	);
	t.true(bottom.includes('data-composer-placement="bottom"'));
	const centred = renderToStaticMarkup(
		createElement(AppShell, {
			title: 'Nanocoder',
			composerPlacement: 'centred',
			children: null,
		}),
	);
	t.true(centred.includes('data-composer-placement="centred"'));
});

test('sidebar footer renders only when it has content', t => {
	const withFooter = renderToStaticMarkup(
		createElement(AppShell, {
			title: 'Nanocoder',
			sidebarFooter: createElement('span', null, 'footer fixture'),
			children: null,
		}),
	);
	t.true(withFooter.includes('shell-sidebar-footer'));
	t.true(withFooter.includes('footer fixture'));
	const without = renderToStaticMarkup(
		createElement(AppShell, {title: 'Nanocoder', children: null}),
	);
	t.false(without.includes('shell-sidebar-footer'));
});

test('later workbench and bottom slots preserve plain children with an explicit return action', t => {
	const html = renderToStaticMarkup(
		createElement(AppShell, {
			title: 'Nanocoder',
			statusBadges: null,
			children: 'chat fixture',
			workbench: {
				title: 'fixture panel',
				children: 'panel fixture',
				onClose() {},
			},
			bottomPanel: 'terminal fixture',
		}),
	);
	t.true(html.includes('data-shell-slot="workbench"'));
	t.regex(html, /aria-label="(close panel|back to chat)"/);
	t.true(html.includes('panel fixture'));
	t.true(html.includes('data-shell-slot="bottom-panel"'));
	t.true(html.includes('terminal fixture'));
});
