import test from 'ava';
import {copyContent, fencedCodeText} from '@/renderer/copy-content';

test('copy writes the original message and announces one success per action', async t => {
	const writes: string[] = [];
	const notices: string[] = [];
	const write = async (text: string) => {
		writes.push(text);
	};
	const notify = (message: string) => notices.push(message);
	await copyContent('first **original** text', write, notify);
	await copyContent('replacement text', write, notify);
	t.deepEqual(writes, ['first **original** text', 'replacement text']);
	t.deepEqual(notices, ['copied', 'copied']);
});

test('copy failure never announces success or exposes the content', async t => {
	const notices: string[] = [];
	await copyContent(
		'private fixture text',
		async () => {
			throw new Error('refused');
		},
		message => notices.push(message),
	);
	t.deepEqual(notices, ['copy failed. clipboard access was refused.']);
	t.false(notices.join(' ').includes('private fixture text'));
});

test('empty and oversized copies leave the clipboard unchanged and explain the limit', async t => {
	const writes: string[] = [];
	const notices: string[] = [];
	await copyContent(
		'',
		async text => {
			writes.push(text);
		},
		text => notices.push(text),
	);
	await copyContent(
		'x'.repeat(1_000_001),
		async text => {
			writes.push(text);
		},
		text => notices.push(text),
	);
	t.deepEqual(writes, []);
	t.deepEqual(notices, [
		'copy failed. text exceeds the 1,000,000 character limit.',
	]);
});

test('fenced copy preserves source newlines and omits fences, language and indentation', t => {
	t.is(
		fencedCodeText('```ts\r\nconst fixture = 1;\r\n\r\n```'),
		'const fixture = 1;\r\n\r\n',
	);
	t.is(fencedCodeText('  ~~~js\n  fixture\n  ~~~'), 'fixture\n');
	t.is(fencedCodeText('```\n```'), '');
	t.is(fencedCodeText('    indented fixture'), undefined);
	t.is(fencedCodeText('```js\r\n> fixture\r\n> ```', '> '), 'fixture\r\n');
	t.is(fencedCodeText('```js\n  fixture\n  ```', '- '), 'fixture\n');
});
