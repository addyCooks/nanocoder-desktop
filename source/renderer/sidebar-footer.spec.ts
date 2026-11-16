import test from 'ava';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SidebarFooter} from '@/renderer/sidebar-footer';

const props: Parameters<typeof SidebarFooter>[0] = {
	acp: {status: 'acp-ready'},
	nanocoderVersion: '1.31.0',
	desktopVersion: '0.0.0',
	onOpenRuntime: () => {},
};
const render = (patch: Partial<typeof props> = {}) =>
	renderToStaticMarkup(createElement(SidebarFooter, {...props, ...patch}));

test('footer shows the supervisor ACP state with a glyph and a word (A-02)', t => {
	const ready = render();
	t.true(ready.includes('<span aria-hidden="true">✓ </span>acp · ready'));
	t.true(
		render({acp: {status: 'acp-exited', exitCode: 3}}).includes(
			'<span aria-hidden="true">× </span>acp · exited (3)',
		),
	);
	t.true(
		render({acp: {status: 'acp-exited'}}).includes(
			'<span aria-hidden="true">× </span>acp · exited<',
		),
	);
	t.true(render({acp: {status: 'acp-starting'}}).includes('acp · starting'));
	t.true(render({acp: null}).includes('acp · not started'));
});

test('footer renders one root element for the shell footer slot (A-28)', t => {
	const html = render({onOpenShortcuts: () => {}});
	t.true(html.startsWith('<div class="sidebar-footer">'));
	t.true(html.endsWith('</div>'));
	t.is(html.match(/<div class="sidebar-footer"/g)?.length, 1);
});

test('footer names untested versions and keeps the version lines (A-28)', t => {
	const html = render({notice: 'untested'});
	t.true(html.includes('Nanocoder 1.31.0 · untested'));
	t.true(html.includes('desktop 0.0.0'));
	t.true(render({nanocoderVersion: null}).includes('Nanocoder not connected'));
	t.false(render().includes('untested'));
});

test('footer names unsupported versions in a short marker', t => {
	t.true(
		render({notice: 'not supported'}).includes(
			'Nanocoder 1.31.0 · not supported',
		),
	);
});

test('a runtime error shows its message and a check-again button in the footer', t => {
	t.false(render().includes('role="alert"'));
	const html = render({
		runtimeError: 'Nanocoder was not found',
		onCheckRuntime: () => {},
	});
	t.true(html.includes('<p role="alert">Nanocoder was not found</p>'));
	t.regex(html, /footer-text-button"[^>]*>check again<\/button>/);
	t.false(
		render({runtimeError: 'Nanocoder was not found'}).includes('check again'),
	);
});

test('runtime and shortcut buttons render only when their owner passes a callback (A-29)', t => {
	t.true(render().includes('aria-label="runtime details"'));
	t.false(render({onOpenRuntime: undefined}).includes('runtime details'));
	t.false(render().includes('aria-label="keyboard shortcuts"'));
	const html = render({onOpenShortcuts: () => {}});
	t.true(html.includes('aria-label="keyboard shortcuts"'));
	t.regex(html, /footer-icon-button"[^>]*><svg[^>]*lucide-keyboard/);
});
