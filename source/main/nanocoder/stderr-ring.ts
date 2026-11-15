const DEFAULT_MAX_BYTES = 256 * 1024;
const MAX_LINE_LENGTH = 4096;
const REDACTED = '[redacted]';

// A key's lines are only recognisable by its header and footer, so the pattern
// takes everything from the header to the footer, or to the end if the footer is absent.
const PRIVATE_KEY =
	/-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|[\s\S]*)/g;

// A header with no footer after it on the same line starts a key that the next lines continue.
const KEY_HEADER =
	/-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----(?![\s\S]*-----END )/;
// What a line inside a key can look like: base64, a long base64 run behind a log prefix, an
// armor or legacy PEM header, or the footer. Any other line means the key has ended.
const KEY_BODY =
	/^\s*[A-Za-z\d+/=]*\s*$|[A-Za-z\d+/=]{32}|^\s*(?:Proc-Type|DEK-Info|Version|Comment|Hash|Charset):|-----END /i;
// No real key runs this long, so a header without a footer cannot blank the ring for good.
const MAX_KEY_LINES = 500;

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
	[/\b([a-z][a-z\d+.-]*:\/\/)[^\s/@]+@/gi, `$1${REDACTED}@`],
	[
		/\b([a-z][a-z\d+.-]*:\/\/)[^\s/?#]*:[^\s/?#]*(?=$|[\s/?#])/gi,
		`$1${REDACTED}`,
	],
	[
		/\b(authorization["']?\s*[:=]\s*["']?)(?:[a-z]+\s+)?[^\s"',;]+/gi,
		`$1${REDACTED}`,
	],
	[/\bbearer\s+[\w.~+/=-]+/gi, `Bearer ${REDACTED}`],
	// A cookie value holds spaces and semicolons, so everything after the name goes.
	[/\b(cookie["']?\s*[:=]\s*["']?).+/gi, `$1${REDACTED}`],
	[
		/\b([\w-]*(?:api[_-]?key|private[_-]?key|(?<!public|primary|sort|cache|foreign|partition|hash|index)[_-]key|token|secret|password|passwd|credential)[\w-]*(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?)[^\s"',;&]+/gi,
		`$1${REDACTED}`,
	],
	[/([?&]key=)[^\s"',;&]+/gi, `$1${REDACTED}`],
	[PRIVATE_KEY, REDACTED],
	[
		/\b(?:sk-[\w-]{16,}|gsk_[\w-]{20,}|hf_[\w-]{20,}|gh[opsur]_\w{20,}|github_pat_\w{20,}|glpat-[\w-]{20,}|xox[abposr]-[\w-]{10,}|AKIA[\dA-Z]{16}|AIza[\w-]{35})/g,
		REDACTED,
	],
	[
		/\b(?:ya29\.[\w.-]{16,}|1\/\/[\w-]{20,}|eyJ[\w-]{4,}\.[\w-]{8,}\.[\w-]{8,})/g,
		REDACTED,
	],
];

function replaceAll(
	text: string,
	needle: string,
	replacement: string,
	ignoreCase: boolean,
): string {
	const matches = (candidate: string) =>
		candidate === needle ||
		(ignoreCase && candidate.toLowerCase() === needle.toLowerCase());
	let result = '';
	let from = 0;
	let at = 0;
	while (at <= text.length - needle.length) {
		if (matches(text.slice(at, at + needle.length))) {
			result += text.slice(from, at) + replacement;
			at += needle.length;
			from = at;
		} else {
			at++;
		}
	}
	return result + text.slice(from);
}

export function redact(
	text: string,
	homeDir?: string,
	platform: NodeJS.Platform = process.platform,
): string {
	let result = text;
	for (const [pattern, replacement] of SECRET_PATTERNS) {
		result = result.replace(pattern, replacement);
	}
	if (homeDir && homeDir.length > 1) {
		const ignoreCase = platform === 'win32' || platform === 'darwin';
		for (const spelling of homeSpellings(homeDir))
			result = replaceAll(result, spelling, '~', ignoreCase);
	}
	return result;
}

// The spellings a path takes in a line: as given, escaped inside JSON or util.inspect
// output, with forward slashes, and percent-encoded in a file URL. This never throws,
// because redaction runs on every line and a home directory can hold any character.
function homeSpellings(homeDir: string): Set<string> {
	const forward = homeDir.replaceAll('\\', '/');
	const spellings = new Set([
		homeDir,
		homeDir.replaceAll('\\', '\\\\'),
		forward,
	]);
	try {
		spellings.add(encodeURI(forward));
	} catch {}
	try {
		// A stack frame spells the path as `pathToFileURL` does, which also escapes `#`, `?`
		// and `%`, and some tools escape the colon after a drive letter as well.
		const rooted = forward.startsWith('/');
		const escaped = forward
			.replace(/^\//, '')
			.replaceAll('%', '%25')
			.replaceAll('#', '%23')
			.replaceAll('?', '%3F');
		const url = new URL(`file:///${escaped}`).pathname.slice(1);
		const path = rooted ? `/${url}` : url;
		spellings.add(path);
		spellings.add(path.replace(/^([a-z]):/i, '$1%3A'));
	} catch {}
	return spellings;
}

function truncate(line: string): string {
	return line.length > MAX_LINE_LENGTH
		? `${line.slice(0, MAX_LINE_LENGTH)} [truncated]`
		: line;
}

// Lines are redacted whole, so a secret split across two chunks is still caught.
export class StderrRing {
	private readonly entries: string[] = [];
	private bytes = 0;
	private partial = '';
	private discarding = false;
	private insideKey = false;
	private keyLines = 0;
	private wasTruncated = false;

	get truncated(): boolean {
		return this.wasTruncated;
	}

	constructor(
		private readonly options: {maxBytes?: number; homeDir?: string} = {},
	) {}

	write(chunk: string): void {
		if (this.discarding) {
			const newline = chunk.indexOf('\n');
			// The dropped part of a long line can hold a key's header, and the lines after it
			// must still be blanked.
			this.openKey(newline === -1 ? chunk : chunk.slice(0, newline));
			if (newline === -1) return;
			chunk = chunk.slice(newline + 1);
			this.discarding = false;
		}
		const parts = (this.partial + chunk).split(/\r?\n/);
		this.partial = parts.pop() ?? '';
		for (const line of parts) {
			this.append(line);
		}
		if (this.partial.length > MAX_LINE_LENGTH) {
			this.wasTruncated = true;
			const wasInside = this.insideKey;
			const keepsKey =
				(wasInside && !this.partial.includes('-----END ')) ||
				KEY_HEADER.test(this.partial);
			this.append('[overlong stderr line omitted]');
			this.insideKey = keepsKey;
			if (keepsKey && !wasInside) this.keyLines = 0;
			this.partial = '';
			this.discarding = true;
		}
	}

	flush(): void {
		if (this.partial) {
			this.append(this.partial);
			this.partial = '';
		}
	}

	private openKey(text: string): void {
		if (!KEY_HEADER.test(text)) return;
		this.insideKey = true;
		this.keyLines = 0;
	}

	append(line: string): void {
		if (line.trim() === '') return;
		if (line.length > MAX_LINE_LENGTH) this.wasTruncated = true;
		// The lines between a key's header and footer carry no marker of their own.
		let text = line;
		if (
			this.insideKey &&
			this.keyLines < MAX_KEY_LINES &&
			KEY_BODY.test(line)
		) {
			this.keyLines++;
			this.insideKey = !line.includes('-----END ');
			text = REDACTED;
		} else {
			this.insideKey = false;
			this.openKey(line);
		}
		let entry = truncate(redact(text, this.options.homeDir));
		const maxBytes = this.options.maxBytes ?? DEFAULT_MAX_BYTES;
		const encoded = Buffer.from(entry);
		if (encoded.length > maxBytes) {
			this.wasTruncated = true;
			let end = Math.max(0, maxBytes);
			while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
			entry = encoded.subarray(0, end).toString('utf8');
		}
		if (!entry) return;
		this.entries.push(entry);
		this.bytes += Buffer.byteLength(entry);
		while (this.bytes > maxBytes && this.entries.length > 1) {
			this.wasTruncated = true;
			this.bytes -= Buffer.byteLength(this.entries.shift() ?? '');
		}
	}

	lines(): readonly string[] {
		return [...this.entries];
	}
}
