import test from 'ava';
import {diagnosticLine} from '@/main/nanocoder/diagnostics';
import {redact, StderrRing} from '@/main/nanocoder/stderr-ring';

const cases: Array<[string, string]> = [
	[
		'fetch https://user:hunter2@example.com/v1 failed',
		'fetch https://[redacted]@example.com/v1 failed',
	],
	['Authorization: Bearer abc.def-ghi', 'Authorization: [redacted]'],
	['{"authorization":"Basic dXNlcjpwYXNz"}', '{"authorization":"[redacted]"}'],
	['retrying with bearer abc123', 'retrying with Bearer [redacted]'],
	[
		'OPENAI_API_KEY=abc123 node cli.js',
		'OPENAI_API_KEY=[redacted] node cli.js',
	],
	['{"apiKey": "abc123"}', '{"apiKey": "[redacted]"}'],
	['GET /v1?token=abc123&page=2', 'GET /v1?token=[redacted]&page=2'],
	['password: hunter2', 'password: [redacted]'],
	['key sk-ant-api03-abcdefghijklmnop rejected', 'key [redacted] rejected'],
	['ghp_abcdefghijklmnopqrstuvwxyz0123 expired', '[redacted] expired'],
	['github_pat_abcdefghijklmnopqrstuvwxyz', '[redacted]'],
	[`aws ${['AKIA', 'ABCDEFGHIJKLMNOP'].join('')}`, 'aws [redacted]'],
	['AIzaabcdefghijklmnopqrstuvwxyz012345678', '[redacted]'],
	['Cookie: sessionid=abc123; csrftoken=zzzz', 'Cookie: [redacted]'],
	['Set-Cookie: session=abc123; HttpOnly', 'Set-Cookie: [redacted]'],
	[
		'Ocp-Apim-Subscription-Key: 0123456789abcdef',
		'Ocp-Apim-Subscription-Key: [redacted]',
	],
	[
		'GET https://api.example.com/v1?key=abc123&x=1',
		'GET https://api.example.com/v1?key=[redacted]&x=1',
	],
	[
		[
			'-----BEGIN PRIVATE KEY-----',
			'MIIEvQIBADAN',
			'-----END PRIVATE KEY-----',
		].join(' '),
		'[redacted]',
	],
	['key -----BEGIN RSA PRIVATE KEY-----', 'key [redacted]'],
	['privateKey: abc123', 'privateKey: [redacted]'],
];

for (const [input, expected] of cases) {
	test(`redacts ${JSON.stringify(input)}`, t => {
		t.is(redact(input), expected);
	});
}

test('leaves ordinary text alone', t => {
	const line = 'Directory /tmp/project is not trusted. Pass --trust-directory.';
	t.is(redact(line), line);
});

test('replaces the home directory', t => {
	t.is(
		redact('open /home/sam/project/a.ts', '/home/sam', 'linux'),
		'open ~/project/a.ts',
	);
	t.is(
		redact('open /HOME/sam/a.ts', '/home/sam', 'linux'),
		'open /HOME/sam/a.ts',
	);
	t.is(
		redact('open C:\\USERS\\Sam\\a.ts', 'C:\\Users\\Sam', 'win32'),
		'open ~\\a.ts',
	);
});

test('replaces the home directory however a Windows path is spelled', t => {
	const home = 'C:\\Users\\Sam Lee';
	for (const [input, expected] of [
		["open 'C:\\Users\\Sam Lee\\a.ts'", "open '~\\a.ts'"],
		["{ path: 'C:\\\\Users\\\\Sam Lee\\\\a.ts' }", "{ path: '~\\\\a.ts' }"],
		['{"cwd":"C:\\\\Users\\\\Sam Lee\\\\a"}', '{"cwd":"~\\\\a"}'],
		['at file:///C:/Users/Sam%20Lee/x.js:1:1', 'at file:///~/x.js:1:1'],
		['open c:/users/sam lee/a.ts', 'open ~/a.ts'],
	])
		t.is(redact(input, home, 'win32'), expected);
});

test('replaces the home directory in a file URL however the account name is escaped', t => {
	for (const [home, platform, input, expected] of [
		[
			'C:\\Users\\Sam#1',
			'win32',
			'at file:///C:/Users/Sam%231/x.js',
			'at file:///~/x.js',
		],
		[
			'C:\\Users\\Sam%1',
			'win32',
			'at file:///C:/Users/Sam%251/x.js',
			'at file:///~/x.js',
		],
		[
			'C:\\Users\\a?b',
			'win32',
			'at file:///C:/Users/a%3Fb/x.js',
			'at file:///~/x.js',
		],
		[
			'C:\\Users\\Sam',
			'win32',
			'at file:///C%3A/Users/Sam/x.js',
			'at file:///~/x.js',
		],
		[
			'C:\\Users\\J\u00fcrgen',
			'win32',
			'at file:///C:/Users/J%C3%BCrgen/x.js',
			'at file:///~/x.js',
		],
		['/home/a#b', 'linux', 'at file:///home/a%23b/x.js', 'at file://~/x.js'],
	] as const)
		t.is(redact(input, home, platform), expected, input);
});

test('redaction never throws, whatever characters the home directory holds', t => {
	const home = 'C:\\Users\\a\ud800b';
	t.notThrows(() => redact('open C:\\Users\\a\ud800b\\f', home, 'win32'));
	t.is(redact('open C:\\Users\\a\ud800b\\f', home, 'win32'), 'open ~\\f');
	t.is(
		redact('open C:\\\\Users\\\\a\ud800b\\\\f', home, 'win32'),
		'open ~\\\\f',
	);
});

test('the startup record survives redaction when the project is under the home directory', t => {
	const home = 'C:\\Users\\Sam';
	const root = 'C:\\Users\\Sam\\proj';
	const ring = new StderrRing({homeDir: home});
	ring.append(JSON.stringify({started: true, pid: 4242, cwd: root}));
	t.is(
		diagnosticLine(ring.lines()[0], redact(root, home, 'win32')),
		'{"started":true,"pid":4242,"cwd":"~\\\\proj"}',
	);
});

test('replaces every spelling of the home directory where case is ignored', t => {
	t.is(
		redact('/Users/Sam/a and /users/sam/b', '/Users/Sam', 'darwin'),
		'~/a and ~/b',
	);
});

test('still ignores case when the line holds a character that lowercases longer', t => {
	t.is(redact('/users/sam/İ', '/Users/Sam', 'darwin'), '~/İ');
	t.is(redact('İ /USERS/SAM/a', '/Users/Sam', 'win32'), 'İ ~/a');
	t.is(redact('/home/İsam/x /HOME/İSAM/y', '/home/İsam', 'win32'), '~/x ~/y');
});

test('matches the home directory exactly where case matters', t => {
	t.is(
		redact('/home/sam/a /HOME/SAM/b', '/home/sam', 'linux'),
		'~/a /HOME/SAM/b',
	);
});

test('ignores a root home directory', t => {
	t.is(redact('/etc/hosts', '/', 'linux'), '/etc/hosts');
});

test('leaves words that only resemble a secret name alone', t => {
	const line = 'hotkey: x, monkey=1, cookies: 3, key: lookup failed';
	t.is(redact(line), line);
});

test('leaves the names of keys that are not secrets alone', t => {
	const line =
		'primary_key=id sort-key: asc cache_key=users public-key: ssh-rsa';
	t.is(redact(line), line);
});

test('a line that only mentions a private key header does not blank the lines after it', t => {
	const ring = new StderrRing();
	ring.write(
		[
			'error: expected -----BEGIN PRIVATE KEY----- header',
			'server listening on 8080',
			'request GET /health 200',
			'',
		].join('\n'),
	);
	t.deepEqual(ring.lines(), [
		'error: expected [redacted]',
		'server listening on 8080',
		'request GET /health 200',
	]);
});

test('a private key header with no footer stops blanking after the longest key', t => {
	const ring = new StderrRing();
	const body = 'A'.repeat(64);
	ring.write(
		[
			'-----BEGIN PRIVATE KEY-----',
			...Array.from({length: 600}, () => body),
			'after',
			'',
		].join('\n'),
	);
	const lines = ring.lines();
	t.is(lines.at(-1), 'after');
	t.is(lines[1], '[redacted]');
});

test('blanks a private key written in pieces, with prefixed lines and armor headers', t => {
	const ring = new StderrRing();
	ring.write('-----BEGIN PGP PRIV');
	ring.write('ATE KEY BLOCK-----\nVersion: GnuPG v2\n');
	ring.write(`2026-11-15 ERROR ${'Zm9vYmFy'.repeat(8)}\n=abcd\n`);
	ring.write('-----END PGP PRIVATE KEY BLOCK-----\ndone running\n');
	t.deepEqual(ring.lines(), [
		'[redacted]',
		'[redacted]',
		'[redacted]',
		'[redacted]',
		'[redacted]',
		'done running',
	]);
});

test('blanks the lines of a private key whose header sat in an overlong line', t => {
	const ring = new StderrRing();
	ring.write(`${'x'.repeat(5000)} -----BEGIN PRIVATE KEY-----`);
	ring.write(
		'\nMIIEvQIBADAN\nKg2oYvBw8Wx3Ig==\n-----END PRIVATE KEY-----\nafter\n',
	);
	t.deepEqual(ring.lines(), [
		'[overlong stderr line omitted]',
		'[redacted]',
		'[redacted]',
		'[redacted]',
		'after',
	]);
});

test('blanks the lines of a private key whose header sat in the dropped end of a long line', t => {
	const ring = new StderrRing();
	ring.write('x'.repeat(5000));
	ring.write(' -----BEGIN PRIVATE KEY-----\n');
	ring.write('MIIEvQIBADAN\n-----END PRIVATE KEY-----\nafter\n');
	t.deepEqual(ring.lines(), [
		'[overlong stderr line omitted]',
		'[redacted]',
		'[redacted]',
		'after',
	]);
});

test('blanks every line of a private key between its header and footer', t => {
	const ring = new StderrRing();
	ring.write(
		[
			'before',
			'-----BEGIN PRIVATE KEY-----',
			'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
			'Kg2oYvBw8Wx3Ig==',
			'-----END PRIVATE KEY-----',
			'after',
			'',
		].join('\n'),
	);
	t.deepEqual(ring.lines(), [
		'before',
		'[redacted]',
		'[redacted]',
		'[redacted]',
		'[redacted]',
		'after',
	]);
});

test('joins lines split across chunks before redacting', t => {
	const ring = new StderrRing();
	ring.write('Authorization: Bearer abc');
	ring.write('def\nnext line\n\n');
	t.deepEqual(ring.lines(), ['Authorization: [redacted]', 'next line']);
});

test('keeps a trailing partial line on flush', t => {
	const ring = new StderrRing();
	ring.write('first\r\nlast');
	t.deepEqual(ring.lines(), ['first']);
	ring.flush();
	t.deepEqual(ring.lines(), ['first', 'last']);
});

test('drops the oldest lines past the size bound', t => {
	const ring = new StderrRing({maxBytes: 20});
	for (const line of ['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc']) {
		ring.append(line);
	}
	t.deepEqual(ring.lines(), ['bbbbbbbbbb', 'cccccccccc']);
});

test('omits an overlong unfinished line until its newline arrives', t => {
	const ring = new StderrRing();
	ring.write('x'.repeat(5000));
	const [line] = ring.lines();
	t.is(line, '[overlong stderr line omitted]');
});

test('returns a copy of its lines', t => {
	const ring = new StderrRing();
	ring.append('one');
	(ring.lines() as string[]).push('two');
	t.deepEqual(ring.lines(), ['one']);
});
