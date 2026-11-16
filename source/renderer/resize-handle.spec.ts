import test from 'ava';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {
	clampSize,
	keyStep,
	parsePanelSizes,
	ResizeHandle,
} from '@/renderer/resize-handle';

test('sizes stay between the limits, and a narrow window keeps the minimum', t => {
	t.is(clampSize(100, 180, 420), 180);
	t.is(clampSize(500, 180, 420), 420);
	t.is(clampSize(250.4, 180, 420), 250);
	t.is(clampSize(300, 280, 200), 280);
});

test('arrow keys along the axis step the size, other keys do nothing', t => {
	t.is(keyStep('ArrowRight', 'x'), 16);
	t.is(keyStep('ArrowLeft', 'x'), -16);
	t.is(keyStep('ArrowDown', 'y'), 16);
	t.is(keyStep('ArrowUp', 'y'), -16);
	t.is(keyStep('ArrowUp', 'x'), null);
	t.is(keyStep('a', 'y'), null);
});

test('saved sizes keep only finite positive numbers for known panels', t => {
	t.deepEqual(parsePanelSizes(null), {});
	t.deepEqual(parsePanelSizes('not json'), {});
	t.deepEqual(
		parsePanelSizes('{"rail":240.6,"workbench":-1,"bottom":"300","other":5}'),
		{rail: 241},
	);
});

test('the handle is a focusable labelled separator with its range', t => {
	const html = renderToStaticMarkup(
		createElement(ResizeHandle, {
			label: 'resize sidebar',
			axis: 'x',
			direction: 1,
			size: 260,
			min: 180,
			max: 420,
			onResize() {},
			onReset() {},
		}),
	);
	t.regex(
		html,
		/role="separator" tabindex="0" aria-label="resize sidebar" aria-orientation="vertical" aria-valuenow="260" aria-valuemin="180" aria-valuemax="420"/,
	);
});
