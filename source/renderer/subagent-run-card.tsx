import * as React from 'react';
import {Button} from '@/renderer/ui';
import {subagentLabel} from '@/shared/subagents';

export const SubagentRunCard = React.memo(function SubagentRunCard({
	title,
	role,
	task,
	position,
	total,
	status,
	history = false,
	historyOutcome,
	running = false,
	stopping = false,
	outcome,
	onStopTurn,
}: {
	title?: string | null;
	role?: string;
	task?: string | null;
	position: number;
	total: number;
	status?: string | null;
	history?: boolean;
	historyOutcome?: unknown;
	running?: boolean;
	stopping?: boolean;
	outcome?: 'completed' | 'failed' | 'cancelled';
	onStopTurn?: () => void;
}) {
	const card = React.useRef<HTMLElement>(null);
	const stopButton = React.useCallback((button: HTMLButtonElement | null) => {
		if (!button) return;
		return () => {
			if (document.activeElement === button && card.current?.isConnected) {
				card.current.focus({preventScroll: true});
			}
		};
	}, []);
	const unfinished = status === 'pending' || status === 'in_progress';
	const state = history
		? historyOutcome === 'failed' || historyOutcome === 'interrupted'
			? historyOutcome
			: historyOutcome === 'completed'
				? 'previously reported completed'
				: 'historical outcome not reported'
		: unfinished && outcome === 'cancelled'
			? 'interrupted'
			: unfinished && outcome === 'failed'
				? 'failed'
				: unfinished && !running
					? 'result not reported'
					: status === 'in_progress'
						? 'running'
						: status
							? (subagentLabel(status.replaceAll('_', ' '), 80) ??
								'state not reported')
							: 'state not reported';
	const canStop = running && !history && !outcome && unfinished && onStopTurn;
	const reportedRole = subagentLabel(role, 160);
	const name = reportedRole ?? 'subagent';
	const progress = subagentLabel(title);
	const historyError =
		history && (state === 'failed' || state === 'interrupted');
	return (
		<section
			ref={card}
			className="subagent-run-card"
			aria-label={`subagent run ${position} of ${total}: ${name}`}
			tabIndex={-1}
		>
			<div className="subagent-head">
				<span className="subagent-task">{subagentLabel(task) ?? name}</span>
				<span
					className={`subagent-state${
						historyError
							? ' subagent-status--error'
							: state === 'running'
								? ' subagent-status--running'
								: ''
					}`}
				>
					<span aria-hidden="true" className="subagent-state-glyph">
						{state === 'completed'
							? '✓'
							: state === 'failed' || (history && state === 'interrupted')
								? '✕'
								: state === 'running'
									? '●'
									: '○'}{' '}
					</span>
					{state}
				</span>
			</div>
			<p className="subagent-role">
				{reportedRole ? `reported role · ${reportedRole}` : 'role not reported'}
			</p>
			{progress && (
				<p className="subagent-progress">
					<span aria-hidden="true">↳ </span>Nanocoder reports: {progress}
				</p>
			)}
			<p className="subagent-fallback">
				depth, elapsed time and child tool details were not reported.
			</p>
			<div className="subagent-foot">
				<span>display-only progress</span>
				{canStop && (
					<Button
						ref={stopButton}
						variant="reject"
						disabled={stopping}
						aria-label={`stop whole turn: ${name}; stops the entire turn and all subagents`}
						onClick={onStopTurn}
					>
						<span aria-hidden="true">✕ </span>
						{stopping ? 'stopping whole turn' : 'stop whole turn'}
					</Button>
				)}
			</div>
		</section>
	);
});
