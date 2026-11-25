import type {
	PermissionRequestInfo,
	StreamCommand,
	StreamConfigOption,
	StreamMetadata,
	StreamPlan,
	StreamToolDetails,
	TurnEvent,
} from '@/shared/ipc';

export type TranscriptItem = (
	| {
			kind: 'user' | 'agent';
			text: string;
			messageId?: string;
			rowId?: string;
			attachmentSummary?: string[];
			// Epoch ms seen live by this renderer; never persisted or estimated.
			at?: number;
	  }
	| {kind: 'thought'; text: string; messageId?: string; rowId?: string}
	| {kind: 'turn-metadata'}
	| {kind: 'failure'; text: string}
	| {
			kind: 'tool';
			id: string;
			title: string;
			status: string;
			toolKind?: string;
			details?: StreamToolDetails;
			delegation?: import('@/shared/subagents').SubagentDisplay;
			approvalOnly?: true;
			historyOutcome?: 'unknown' | 'completed' | 'failed' | 'interrupted';
			turnOutcome?: 'completed' | 'failed' | 'cancelled';
	  }
	| {kind: 'plan'; id: string | null; content: StreamPlan}
	| {kind: 'notice'; severity: string; title: string; description?: string}
	| {
			kind: 'compaction';
			id: string;
			status: string;
			summary?: string | null;
			error?: string | null;
	  }
	| {
			kind: 'subagent';
			id: string;
			title?: string | null;
			description?: string | null;
			state?: string | null;
	  }
	| {
			kind: 'session-message';
			id: string;
			sender?: string;
			recipient?: string;
			text: string;
	  }
) & {metadata?: StreamMetadata};

export interface Transcript {
	items: TranscriptItem[];
	// Every request still waiting for an answer, oldest first.
	permissions: PermissionRequestInfo[];
	commands?: StreamCommand[];
	mode?: string;
	config?: StreamConfigOption[];
	context?: {
		used: number;
		size: number;
		cost?: {amount: number; currency: string};
	};
}

export const emptyTranscript: Transcript = {items: [], permissions: []};

export function settleSubagentTurn(
	transcript: Transcript,
	outcome: 'completed' | 'failed' | 'cancelled',
): Transcript {
	const start = currentTurnStart(transcript.items);
	let changed = false;
	const items = transcript.items.map((item, index) => {
		if (
			index <= start ||
			item.kind !== 'tool' ||
			!item.delegation ||
			item.delegation.history ||
			item.turnOutcome ||
			!['pending', 'in_progress'].includes(item.status)
		)
			return item;
		changed = true;
		return {...item, turnOutcome: outcome};
	});
	return changed ? {...transcript, items} : transcript;
}

export function currentTurnStart(items: readonly TranscriptItem[]): number {
	for (let index = items.length - 1; index >= 0; index--)
		if (items[index].kind === 'user') return index;
	return -1;
}

function fingerprint(text: string): string {
	let hash = 2166136261;
	for (let index = 0; index < text.length; index++)
		hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
	return `${(hash >>> 0).toString(36)}-${text.length.toString(36)}`;
}

function fallbackRowId(kind: string, index: number, text: string): string {
	return `${kind}:${index}:${fingerprint(text)}`;
}

export function transcriptRowId(item: TranscriptItem, index: number): string {
	if ('id' in item && item.id !== null) return `${item.kind}:${item.id}`;
	if ('messageId' in item && item.messageId)
		return `${item.kind}:${item.messageId}`;
	if ('rowId' in item && item.rowId) return `${item.kind}:${item.rowId}`;
	const text =
		'text' in item && typeof item.text === 'string'
			? item.text
			: 'title' in item && typeof item.title === 'string'
				? item.title
				: '';
	return fallbackRowId(item.kind, index, text);
}

function upsert(
	transcript: Transcript,
	matches: (item: TranscriptItem, index: number) => boolean,
	update: (previous?: TranscriptItem) => TranscriptItem,
): Transcript {
	const index = transcript.items.findIndex(matches);
	const items = [...transcript.items];
	if (index < 0) items.push(update());
	else items[index] = update(items[index]);
	return {...transcript, items};
}

function applyContent(
	transcript: Transcript,
	event: TurnEvent,
	at: number | undefined,
): Transcript {
	const {items} = transcript;
	switch (event.type) {
		case 'metadata':
			return transcript;
		case 'commands':
			return {...transcript, commands: event.commands};
		case 'mode':
			return {...transcript, mode: event.id};
		case 'config':
			return {...transcript, config: event.options};
		case 'context':
			return {
				...transcript,
				context: {
					used: event.used,
					size: event.size,
					...(event.cost ? {cost: event.cost} : {}),
				},
			};
		case 'user':
		case 'text':
		case 'thought': {
			const kind = event.type === 'text' ? 'agent' : event.type;
			const last = items.at(-1);
			const join =
				last?.kind === kind &&
				last.messageId === event.messageId &&
				(kind !== 'user' || event.messageId !== undefined);
			const item: TranscriptItem = join
				? {...last, text: last.text + event.text}
				: {
						kind,
						text: event.text,
						...(event.type === 'user' && event.attachmentSummary
							? {attachmentSummary: event.attachmentSummary}
							: {}),
						...(event.messageId
							? {messageId: event.messageId}
							: {rowId: fallbackRowId('live', items.length, event.text)}),
						...(at !== undefined && kind !== 'thought' ? {at} : {}),
					};
			return {
				...transcript,
				items: join ? [...items.slice(0, -1), item] : [...items, item],
			};
		}
		case 'tool': {
			const start = currentTurnStart(items);
			return upsert(
				transcript,
				(item, index) =>
					item.kind === 'tool' && item.id === event.id && index > start,
				previous => {
					const known = previous?.kind === 'tool' ? previous : undefined;
					if (
						known &&
						(known.turnOutcome ||
							['completed', 'failed', 'cancelled'].includes(known.status)) &&
						(event.status === 'pending' || event.status === 'in_progress')
					)
						return known;
					const reported = event.history?.outcome;
					const historyOutcome =
						reported === 'unknown' ||
						reported === 'completed' ||
						reported === 'failed' ||
						reported === 'interrupted'
							? reported
							: event.history === undefined
								? known?.historyOutcome
								: undefined;
					return {
						kind: 'tool',
						id: event.id,
						title: event.title ?? known?.title ?? event.id,
						status: event.status ?? known?.status ?? 'pending',
						...(historyOutcome ? {historyOutcome} : {}),
						...(known?.turnOutcome ? {turnOutcome: known.turnOutcome} : {}),
						...(event.toolKind || known?.toolKind
							? {toolKind: event.toolKind ?? known?.toolKind}
							: {}),
						...(event.details || known?.details
							? {details: {...known?.details, ...event.details}}
							: {}),
						...(known?.delegation || event.delegation
							? {delegation: known?.delegation ?? event.delegation}
							: {}),
						...(known?.approvalOnly || event.approvalOnly
							? {approvalOnly: true}
							: {}),
					};
				},
			);
		}
		case 'plan':
			if (event.content === null)
				return {
					...transcript,
					items: items.filter(
						item => item.kind !== 'plan' || item.id !== event.id,
					),
				};
			return upsert(
				transcript,
				item => item.kind === 'plan' && item.id === event.id,
				() => ({
					kind: 'plan',
					id: event.id,
					content: event.content as StreamPlan,
				}),
			);
		case 'notice':
			return {
				...transcript,
				items: [
					...items,
					{
						kind: 'notice',
						severity: event.severity,
						title: event.title,
						...(event.description === undefined
							? {}
							: {description: event.description}),
					},
				],
			};
		case 'compaction':
		case 'compaction-chunk':
			return upsert(
				transcript,
				item => item.kind === 'compaction' && item.id === event.id,
				previous => {
					const known = previous?.kind === 'compaction' ? previous : undefined;
					return event.type === 'compaction-chunk'
						? {
								...known,
								kind: 'compaction',
								id: event.id,
								status: known?.status ?? 'in_progress',
								summary: (known?.summary ?? '') + event.text,
							}
						: {
								...known,
								kind: 'compaction',
								id: event.id,
								status: event.status,
								...(event.summary === undefined
									? {}
									: {summary: event.summary}),
								...(event.error === undefined ? {} : {error: event.error}),
							};
				},
			);
		case 'subagent':
			return upsert(
				transcript,
				item => item.kind === 'subagent' && item.id === event.id,
				previous => ({
					...(previous?.kind === 'subagent' ? previous : {}),
					kind: 'subagent',
					id: event.id,
					...(event.title === undefined ? {} : {title: event.title}),
					...(event.description === undefined
						? {}
						: {description: event.description}),
					...(event.state === undefined ? {} : {state: event.state}),
				}),
			);
		case 'session-message':
			return upsert(
				transcript,
				item => item.kind === 'session-message' && item.id === event.id,
				previous => {
					const known =
						previous?.kind === 'session-message' ? previous : undefined;
					return {
						...known,
						kind: 'session-message',
						id: event.id,
						text:
							event.text === undefined
								? (known?.text ?? '')
								: event.append
									? (known?.text ?? '') + event.text
									: event.text,
						...(event.sender === undefined ? {} : {sender: event.sender}),
						...(event.recipient === undefined
							? {}
							: {recipient: event.recipient}),
					};
				},
			);
		case 'permission':
			return {
				...transcript,
				permissions: [
					...transcript.permissions.filter(
						request => request.id !== event.request.id,
					),
					event.request,
				],
			};
		case 'permission-closed':
			return {
				...transcript,
				permissions: transcript.permissions.filter(
					request => request.id !== event.id,
				),
			};
	}
}

function mergeMetadata(
	previous: StreamMetadata | undefined,
	next: StreamMetadata,
): StreamMetadata {
	return {
		...previous,
		...next,
		...(next.usage ? {usage: {...previous?.usage, ...next.usage}} : {}),
	};
}

export function applyEvent(
	transcript: Transcript,
	event: TurnEvent,
	at?: number,
): Transcript {
	const next = applyContent(transcript, event, at);
	if (!event.metadata) return next;
	let index = -1;
	for (let cursor = next.items.length - 1; cursor >= 0; cursor--) {
		const {kind} = next.items[cursor];
		if (kind === 'user') break;
		if (kind === 'turn-metadata') {
			index = cursor;
			break;
		}
		if (kind === 'agent' && index < 0) index = cursor;
	}
	if (index < 0)
		return {
			...next,
			items: [...next.items, {kind: 'turn-metadata', metadata: event.metadata}],
		};
	const items = [...next.items];
	const item = items[index];
	items[index] = {
		...item,
		metadata: mergeMetadata(item.metadata, event.metadata),
	};
	return {...next, items};
}

export function applyEvents(
	transcript: Transcript,
	events: readonly TurnEvent[],
	at?: number,
): Transcript {
	return events.reduce(
		(current, event) => applyEvent(current, event, at),
		transcript,
	);
}

type Message = Extract<TranscriptItem, {kind: 'user' | 'agent'}>;

// A shared message id is the only proof of identity. Exact text counts only
// when neither side has an id, and empty agent text never counts.
function sameMessage(earlier: Message, item: Message): boolean {
	if (earlier.kind !== item.kind) return false;
	if (earlier.kind === 'agent' && (earlier.text === '' || item.text === ''))
		return false;
	if (earlier.messageId !== undefined || item.messageId !== undefined)
		return earlier.messageId === item.messageId;
	return earlier.text === item.text;
}

export function carryMessageRows(
	previous: Transcript,
	next: Transcript,
): Transcript {
	let changed = false;
	const items = next.items.map((item, index) => {
		const earlier = previous.items[index];
		if (
			(item.kind !== 'user' &&
				item.kind !== 'agent' &&
				item.kind !== 'thought') ||
			item.messageId
		)
			return item;
		const rowId =
			earlier?.kind === item.kind &&
			earlier.messageId === item.messageId &&
			earlier.text === item.text &&
			earlier.rowId
				? earlier.rowId
				: fallbackRowId('snapshot', index, item.text);
		if (item.rowId === rowId) return item;
		changed = true;
		return {...item, rowId};
	});
	return changed ? {...next, items} : next;
}

export function carryMessageTimes(
	previous: Transcript,
	next: Transcript,
): Transcript {
	const earlier = previous.items.filter(
		(item): item is Message => item.kind === 'user' || item.kind === 'agent',
	);
	const used = new Set<Message>();
	let changed = false;
	const items = next.items.map(item => {
		if (
			(item.kind !== 'user' && item.kind !== 'agent') ||
			item.at !== undefined
		)
			return item;
		const matches = earlier.filter(
			candidate => !used.has(candidate) && sameMessage(candidate, item),
		);
		if (matches.length !== 1) return item;
		const [match] = matches;
		used.add(match);
		if (match.at === undefined) return item;
		changed = true;
		return {...item, at: match.at};
	});
	return changed ? {...next, items} : next;
}
