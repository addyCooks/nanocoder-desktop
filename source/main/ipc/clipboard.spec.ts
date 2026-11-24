import test from 'ava';
import {clipboardWriteSchema, writeClipboard} from '@/main/ipc/clipboard';
import {handleRequest, type Sender} from '@/main/ipc/handle-request';
import {APP_ORIGIN} from '@/main/security';

const sender: Sender = {url: 'app://renderer/index.html', isMainFrame: true};

function request(payload: unknown, write: (text: string) => void) {
	return handleRequest({
		sender,
		payload,
		schema: clipboardWriteSchema,
		handler: request => writeClipboard(request, write),
		allowedOrigins: [APP_ORIGIN],
	});
}

test('clipboard write accepts only bounded text and replaces the previous value', async t => {
	const writes: string[] = [];
	t.deepEqual(
		await request({text: 'first fixture'}, text => writes.push(text)),
		{
			ok: true,
			value: null,
		},
	);
	t.deepEqual(await request({text: 'replacement'}, text => writes.push(text)), {
		ok: true,
		value: null,
	});
	t.deepEqual(writes, ['first fixture', 'replacement']);
});

test('clipboard write refuses malformed, unknown and oversized requests without writing', async t => {
	let writes = 0;
	for (const payload of [
		{},
		{text: ''},
		{text: 42},
		{text: 'fixture', read: true},
		{text: 'x'.repeat(1_000_001)},
	]) {
		const result = await request(payload, () => {
			writes++;
		});
		t.false(result.ok);
		if (!result.ok) t.is(result.error.code, 'VALIDATION');
	}
	t.is(writes, 0);
});

test('clipboard write refuses an untrusted sender before looking at the text', async t => {
	let writes = 0;
	const result = await handleRequest({
		sender: {url: 'https://fixture.invalid', isMainFrame: true},
		payload: {text: 'private fixture'},
		schema: clipboardWriteSchema,
		handler: request =>
			writeClipboard(request, () => {
				writes++;
			}),
		allowedOrigins: [APP_ORIGIN],
	});
	t.false(result.ok);
	if (!result.ok) t.is(result.error.code, 'DENIED');
	t.is(writes, 0);
});

test('clipboard failure returns no copied content or underlying error detail', async t => {
	const result = await request({text: 'private fixture'}, () => {
		throw new Error('private fixture failed');
	});
	t.deepEqual(result, {
		ok: false,
		error: {
			code: 'UNAVAILABLE',
			message: 'Clipboard write failed',
			retryable: true,
		},
	});
	t.false(JSON.stringify(result).includes('private fixture'));
});
