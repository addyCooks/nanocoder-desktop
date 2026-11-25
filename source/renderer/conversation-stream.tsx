import * as React from 'react';
import {
	AgentMarkdown,
	CopyContext,
	LocalUrlContext,
} from '@/renderer/agent-markdown';
import {Icon} from '@/renderer/icons';
import {
	clockTime,
	dayLabel,
	timeStamp,
	untimedHistoryTitle,
} from '@/renderer/message-time';
import {StreamAnnouncements} from '@/renderer/stream-announcements';
import {SubagentRunCard} from '@/renderer/subagent-run-card';
import {
	currentTurnStart,
	type Transcript,
	type TranscriptItem,
	transcriptRowId,
} from '@/renderer/transcript';
import type {StreamMetadata, StreamToolDetails} from '@/shared/ipc';

function ReportedMetadata({metadata}: {metadata?: StreamMetadata}) {
	if (!metadata) return null;
	const usage = metadata.usage;
	const tokens = usage?.totalTokens;
	const tokenLabel =
		tokens !== undefined
			? `+${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tok`
			: [
					usage?.inputTokens === undefined ? '' : `${usage.inputTokens} in`,
					usage?.outputTokens === undefined ? '' : `${usage.outputTokens} out`,
				]
					.filter(Boolean)
					.join(' · ');
	return (
		<div className="stream-reported">
			{tokenLabel && (
				<span className="stream-token-chip" title="reported token usage">
					{tokenLabel}
				</span>
			)}
			{usage?.cost !== undefined && <span>reported cost: {usage.cost}</span>}
			{metadata.durationMs !== undefined && (
				<span>reported duration: {metadata.durationMs} ms</span>
			)}
			{metadata.outcome && <span>{metadata.outcome}</span>}
			{metadata.artifacts?.map(artifact => (
				<span key={`${artifact.kind}:${artifact.path}`}>
					{artifact.kind}: {artifact.path} (not opened)
				</span>
			))}
		</div>
	);
}

function glyph(status: string) {
	return status === 'completed'
		? '✓'
		: status === 'failed' || status === 'cancelled'
			? '✕'
			: status === 'in_progress'
				? '●'
				: status === 'pending'
					? '○'
					: '◌';
}

function toolWord(status: string) {
	return status === 'completed'
		? ''
		: status === 'in_progress'
			? 'running'
			: status.replaceAll('_', ' ');
}

function ToolDetails({details}: {details: StreamToolDetails}) {
	return (
		<div className="stream-tool-details">
			{details.locations?.map((location, index) => (
				<p key={`${location.path}:${index}`}>
					{location.path}
					{location.line === undefined ? '' : `:${location.line}`}
				</p>
			))}
			{details.input !== undefined && (
				<>
					<p>input</p>
					<pre>{details.input}</pre>
				</>
			)}
			{details.output !== undefined && (
				<>
					<p>output</p>
					<pre>{details.output}</pre>
				</>
			)}
			{details.content?.map((text, index) => (
				<pre key={index}>{text}</pre>
			))}
		</div>
	);
}

function isSubagentRun(item: TranscriptItem) {
	return (
		item.kind === 'subagent' || (item.kind === 'tool' && !!item.delegation)
	);
}

function isPanelTool(item: TranscriptItem | undefined) {
	return item?.kind === 'tool' && !item.delegation;
}

function isAgentTurnItem(item: TranscriptItem) {
	return (
		item.kind === 'agent' ||
		item.kind === 'thought' ||
		item.kind === 'plan' ||
		isPanelTool(item)
	);
}

// One agent label per turn, timed from the turn's first live agent message.
function agentLabels(items: readonly TranscriptItem[]) {
	const labels = new Map<number, {at?: number}>();
	let current: {at?: number} | null = null;
	for (const [index, item] of items.entries()) {
		if (item.kind === 'user') current = null;
		else if (isAgentTurnItem(item)) {
			if (!current) {
				current = {};
				labels.set(index, current);
			}
			if (item.kind === 'agent' && current.at === undefined)
				current.at = item.at;
		}
	}
	return labels;
}

function firstTime(items: readonly TranscriptItem[]) {
	for (const item of items)
		if (
			(item.kind === 'user' || item.kind === 'agent') &&
			item.at !== undefined
		)
			return item.at;
	return undefined;
}

function toolGroup(items: readonly TranscriptItem[], index: number) {
	if (!isPanelTool(items[index])) return undefined;
	const first = index === 0 || !isPanelTool(items[index - 1]);
	const last = !isPanelTool(items[index + 1]);
	return first ? (last ? 'only' : 'first') : last ? 'last' : 'middle';
}

function AgentLabel({at}: {at?: number}) {
	return (
		<li className="gate-message-label">
			<div className="stream-author stream-author-agent">
				Nanocoder
				{at !== undefined && (
					<>
						{' '}
						<time className="stream-time" dateTime={timeStamp(at)}>
							{clockTime(at)}
						</time>
					</>
				)}
			</div>
		</li>
	);
}

function CopyMessage({text}: {text: string}) {
	const copy = React.useContext(CopyContext);
	if (!copy || !text.length) return null;
	return (
		<div className="stream-message-actions">
			<button
				type="button"
				className="stream-copy"
				aria-label="copy text"
				title="copy text"
				onClick={() => copy(text)}
			>
				<Icon name="copy" size={14} />
			</button>
		</div>
	);
}

const StreamRow = React.memo(function StreamRow({
	item,
	runPosition,
	runCount,
	streaming,
	active,
	stopping,
	onStopTurn,
	outcome,
	group,
	notice,
}: {
	item: TranscriptItem;
	runPosition: number;
	runCount: number;
	streaming: boolean;
	active: boolean;
	stopping: boolean;
	onStopTurn?: () => void;
	outcome?: 'completed' | 'failed' | 'cancelled';
	group?: string;
	notice?: React.ReactNode;
}) {
	let content: React.ReactNode;
	switch (item.kind) {
		case 'user':
			content = (
				<>
					<div className="stream-author">
						you
						{item.at !== undefined && (
							<>
								{' '}
								<time className="stream-time" dateTime={timeStamp(item.at)}>
									{clockTime(item.at)}
								</time>
							</>
						)}
					</div>
					<CopyMessage text={item.text} />
					<div className="stream-plain">{item.text}</div>
					{item.attachmentSummary?.length ? (
						<div className="stream-plain">
							{item.attachmentSummary.join('\n')}
						</div>
					) : null}
				</>
			);
			break;
		case 'agent':
			content = (
				<>
					<CopyMessage text={item.text} />
					<ReportedMetadata metadata={item.metadata} />
					<AgentMarkdown text={item.text} />
					{streaming && (
						<span className="stream-cursor" aria-label="streaming">
							▌
						</span>
					)}
				</>
			);
			break;
		case 'thought':
			content = (
				<details className="stream-reasoning" open={streaming || undefined}>
					<summary>
						<span className="stream-disclosure" aria-hidden="true" />
						<span aria-hidden="true">◌ </span>reasoning · reported by Nanocoder
					</summary>
					<p>{item.text}</p>
				</details>
			);
			break;
		case 'turn-metadata':
			content = (
				<>
					<div className="stream-author">turn details</div>
					<ReportedMetadata metadata={item.metadata} />
				</>
			);
			break;
		case 'failure':
			content = notice ?? (
				<>
					<span aria-hidden="true">✕ </span>failed turn: {item.text}
				</>
			);
			break;
		case 'tool': {
			if (item.delegation) {
				content = (
					<SubagentRunCard
						position={runPosition}
						total={runCount}
						title={item.title}
						role={item.delegation.role}
						task={item.delegation.task}
						status={item.status}
						history={item.delegation.history}
						historyOutcome={item.historyOutcome}
						running={active}
						stopping={stopping}
						outcome={item.turnOutcome ?? outcome}
						onStopTurn={onStopTurn}
					/>
				);
				break;
			}
			const details = item.details;
			const hasDetails =
				!!details &&
				(!!details.content?.length ||
					!!details.locations?.length ||
					details.input !== undefined ||
					details.output !== undefined);
			const running = item.status === 'in_progress';
			const kindInTitle =
				!running &&
				!!item.toolKind &&
				item.title.startsWith(`${item.toolKind} `);
			const word =
				item.approvalOnly && item.status === 'completed'
					? 'approved · execution result not reported'
					: toolWord(item.status);
			const foldable = hasDetails || running;
			const summary = (
				<>
					{foldable && (
						<span className="stream-disclosure" aria-hidden="true" />
					)}
					<span
						className={`stream-tool-status${running ? ' spinner' : ''}`}
						aria-hidden="true"
					>
						{glyph(item.status)}
					</span>
					{item.status === 'completed' && (
						<span className="sr-only">completed </span>
					)}
					{word && <span className="stream-tool-state">{word} </span>}
					{item.toolKind && !kindInTitle && (
						<span className="stream-tool-verb">{item.toolKind} </span>
					)}
					{!running && <code className="stream-tool-name">{item.title}</code>}
				</>
			);
			content = foldable ? (
				<details
					open={
						running ||
						item.status === 'failed' ||
						item.status === 'cancelled' ||
						undefined
					}
				>
					<summary>{summary}</summary>
					{running && <p className="stream-tool-detail">{item.title}</p>}
					{details && hasDetails && <ToolDetails details={details} />}
					{running && (
						<p className="stream-tool-wait">
							waiting for Nanocoder's tool result
						</p>
					)}
				</details>
			) : (
				<div className="stream-tool-summary">{summary}</div>
			);
			break;
		}
		case 'plan':
			content = (
				<>
					<div className="stream-author">plan</div>
					{item.content.kind === 'items' ? (
						<ul>
							{item.content.entries.map((entry, index) => (
								<li key={index}>
									<span aria-hidden="true">{glyph(entry.status)} </span>
									{entry.content} · {entry.status.replaceAll('_', ' ')} ·{' '}
									{entry.priority}
								</li>
							))}
						</ul>
					) : item.content.kind === 'markdown' ? (
						<AgentMarkdown text={item.content.text} />
					) : (
						<p>
							plan file not opened: <code>{item.content.uri}</code>
						</p>
					)}
				</>
			);
			break;
		case 'notice':
			content = (
				<>
					<span aria-hidden="true">
						{item.severity === 'error'
							? '✕'
							: item.severity === 'warning'
								? '▲'
								: '○'}{' '}
					</span>
					{item.severity}: {item.title}
					{item.description && <p>{item.description}</p>}
				</>
			);
			break;
		case 'compaction':
			content = (
				<details>
					<summary>
						<span aria-hidden="true">{glyph(item.status)} </span>context
						compaction: {item.status.replaceAll('_', ' ')}
					</summary>
					{item.summary && <div className="stream-plain">{item.summary}</div>}
					{item.error && <p>{item.error}</p>}
				</details>
			);
			break;
		case 'subagent':
			content = (
				<SubagentRunCard
					position={runPosition}
					total={runCount}
					title={item.title}
					task={item.description}
					status={item.state}
				/>
			);
			break;
		case 'session-message':
			content = (
				<>
					<div className="stream-author">inter-session message</div>
					<div className="stream-plain">
						{item.text || 'content not reported'}
					</div>
				</>
			);
			break;
	}
	return (
		<li
			className={`gate-message-${item.kind}${group ? ` stream-tool-${group}` : ''}`}
			data-status={'status' in item ? item.status : undefined}
		>
			{content}
		</li>
	);
});

export function ConversationStream({
	transcript,
	running,
	children,
	onStopTurn,
	stopping = false,
	outcome,
	stopReason,
	failureNotice,
	onOpenLocalUrl,
	onCopy,
	now = Date.now,
}: {
	transcript: Transcript;
	running: boolean;
	children?: React.ReactNode;
	onStopTurn?: () => Promise<void>;
	stopping?: boolean;
	outcome?: 'completed' | 'failed' | 'cancelled';
	stopReason?: string;
	failureNotice?: React.ReactNode;
	onOpenLocalUrl?: (url: string) => void;
	onCopy?: (text: string) => void;
	now?: () => number;
}) {
	const stop = React.useRef(onStopTurn);
	const pending = React.useRef(false);
	const [localStopping, setLocalStopping] = React.useState(false);
	const [stopError, setStopError] = React.useState('');
	React.useEffect(() => {
		stop.current = onStopTurn;
	}, [onStopTurn]);
	const stopTurn = React.useCallback(() => {
		const action = stop.current;
		if (pending.current || !action) return;
		pending.current = true;
		setLocalStopping(true);
		setStopError('');
		void (async () => {
			try {
				await action();
			} catch {
				setStopError('could not stop the turn. try again.');
			} finally {
				pending.current = false;
				setLocalStopping(false);
			}
		})();
	}, []);
	const turnStart = currentTurnStart(transcript.items);
	const keyOccurrences = new Map<string, number>();
	const runCount = transcript.items.filter(isSubagentRun).length;
	const labels = agentLabels(transcript.items);
	const lastFailure = transcript.items
		.map(item => item.kind)
		.lastIndexOf('failure');
	const dayTime = firstTime(transcript.items);
	let runPosition = 0;
	const context = transcript.context;
	const percentage = context
		? Math.min(
				100,
				Math.max(0, Math.round((context.used / context.size) * 100)),
			)
		: 0;
	return (
		<CopyContext.Provider value={onCopy}>
			<LocalUrlContext.Provider value={onOpenLocalUrl}>
				<section
					className="conversation-stream"
					data-stop-reason={stopReason}
					data-empty={transcript.items.length === 0 || undefined}
				>
					{transcript.items.length > 0 &&
						(dayTime === undefined ? (
							<p className="stream-day-label" title={untimedHistoryTitle}>
								saved history
							</p>
						) : (
							<p className="stream-day-label">{dayLabel(dayTime, now())}</p>
						))}
					<ol className="gate-transcript" aria-label="conversation">
						{transcript.items.map((item, index) => {
							if (isSubagentRun(item)) runPosition++;
							const base = transcriptRowId(item, index);
							const occurrence = keyOccurrences.get(base) ?? 0;
							keyOccurrences.set(base, occurrence + 1);
							const key = `${base}:${occurrence}`;
							const label = labels.get(index);
							const row = (
								<StreamRow
									key={key}
									item={item}
									runPosition={runPosition}
									runCount={runCount}
									active={running && index > turnStart}
									outcome={index > turnStart ? outcome : undefined}
									stopping={stopping || localStopping}
									onStopTurn={onStopTurn ? stopTurn : undefined}
									group={toolGroup(transcript.items, index)}
									notice={index === lastFailure ? failureNotice : undefined}
									streaming={
										running &&
										(item.kind === 'agent' || item.kind === 'thought') &&
										index === transcript.items.length - 1
									}
								/>
							);
							return label ? (
								<React.Fragment key={key}>
									<AgentLabel at={label.at} />
									{row}
								</React.Fragment>
							) : (
								row
							);
						})}
					</ol>
					<StreamAnnouncements
						transcript={transcript}
						running={running}
						outcome={outcome}
					/>
					{stopError && <p role="alert">{stopError}</p>}
					{stopReason !== undefined && stopReason !== 'end_turn' && (
						<p className="stream-turn-note">
							{stopReason === 'cancelled'
								? 'turn interrupted'
								: 'turn stopped early'}
						</p>
					)}
					{transcript.mode && (
						<p className="stream-session">reported mode: {transcript.mode}</p>
					)}
					{!!transcript.config?.length && (
						<details className="stream-session">
							<summary>reported configuration</summary>
							<dl>
								{transcript.config.map(option => (
									<React.Fragment key={option.id}>
										<dt>{option.name}</dt>
										<dd>{String(option.value)}</dd>
									</React.Fragment>
								))}
							</dl>
						</details>
					)}
					{context && (
						<div className="stream-context">
							<p>
								reported context: {context.used} / {context.size} tokens
								{context.cost && (
									<>
										{' '}
										· session cost: {context.cost.amount}{' '}
										{context.cost.currency}
									</>
								)}
							</p>
							<div
								role="progressbar"
								aria-label="reported context use"
								aria-valuemin={0}
								aria-valuemax={100}
								aria-valuenow={percentage}
								aria-valuetext={`${context.used} of ${context.size} reported context tokens`}
							>
								<span style={{width: `${percentage}%`}} />
							</div>
						</div>
					)}
					{children}
				</section>
			</LocalUrlContext.Provider>
		</CopyContext.Provider>
	);
}
