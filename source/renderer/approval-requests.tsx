import * as React from 'react';
import {keyHint} from '@/renderer/overlay-model';
import {Button, Card} from '@/renderer/ui';
import type {
	IpcResult,
	NanocoderMode,
	PermissionOptionInfo,
	PermissionRequestInfo,
} from '@/shared/ipc';

const QUESTION_TITLE = 'Nanocoder needs a choice';
const QUESTION_META =
	'ask_user · ACP supports selectable options only. no free-text answer is invented.';
const APPROVAL_EFFECT =
	'your choice is sent to Nanocoder; nothing is selected by default. approval does not guarantee success.';
const POLICY_NOTE =
	'"allow always" changes Nanocoder\'s policy, not desktop trust.';
const NO_OPTIONS = 'Nanocoder offered no options; cancel the turn to continue.';

type ShortcutKey = Pick<
	KeyboardEvent,
	'key' | 'repeat' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'
>;

export function shortcutOption(
	event: ShortcutKey,
	options: readonly PermissionOptionInfo[],
): PermissionOptionInfo | undefined {
	if (
		event.repeat ||
		event.altKey ||
		event.ctrlKey ||
		event.metaKey ||
		event.shiftKey ||
		!/^[1-9]$/.test(event.key)
	)
		return undefined;
	return options[Number(event.key) - 1];
}

// Nanocoder's tool titles lead with the tool name, as in "execute_bash: ls".
const TOOL_TITLE = /^([a-z][a-z0-9_]{0,63}): /;

export function reportedToolName(title: string): string | undefined {
	return TOOL_TITLE.exec(title)?.[1];
}

export function openQuestionId(
	requests: readonly PermissionRequestInfo[],
	collapsed: ReadonlySet<string>,
): string | undefined {
	const first = requests[0];
	return first?.question === true && !collapsed.has(first.id)
		? first.id
		: undefined;
}

function canFocus(
	target: HTMLElement | null | undefined,
): target is HTMLElement {
	return !!(
		target?.isConnected &&
		!target.matches(':disabled, [hidden]') &&
		target.getClientRects().length
	);
}

// Asks the DOM, not the shelf ref: a dialog focuses itself before the ref attaches.
export function isOutsideShelf(
	active: Element | null,
	body: Element | null,
): active is HTMLElement {
	return (
		active instanceof HTMLElement &&
		active !== body &&
		!active.closest('.approval-requests')
	);
}

function useApprovalFocus(
	requests: readonly PermissionRequestInfo[],
	answering: boolean,
	busy: boolean,
	questionId: string | undefined,
	fallback?: React.RefObject<HTMLElement | null>,
) {
	const container = React.useRef<HTMLDivElement>(null);
	const dialogs = React.useRef(new Map<string, HTMLDivElement>());
	const lastOutside = React.useRef<HTMLElement | null>(null);
	const origin = React.useRef<HTMLElement | null | undefined>(undefined);
	const previous = React.useRef<string | undefined>(undefined);
	const collapsedFocus = React.useRef<string | undefined>(undefined);

	React.useEffect(() => {
		const remember = () => {
			const active = document.activeElement;
			if (isOutsideShelf(active, document.body)) lastOutside.current = active;
		};
		remember();
		document.addEventListener('focusin', remember);
		return () => document.removeEventListener('focusin', remember);
	}, []);

	React.useLayoutEffect(() => {
		const firstId = requests[0]?.id;
		if (firstId && origin.current === undefined) {
			const active = document.activeElement;
			origin.current = isOutsideShelf(active, document.body)
				? active
				: lastOutside.current;
		}
		const focus = () => {
			if (answering || questionId || document.querySelector('dialog:modal'))
				return;
			if (firstId) {
				if (
					previous.current !== firstId ||
					collapsedFocus.current === firstId ||
					document.activeElement === document.body
				) {
					const dialog = dialogs.current.get(firstId);
					if (dialog) collapsedFocus.current = undefined;
					dialog?.focus({preventScroll: true});
					dialog
						?.closest('.ui-card--approval')
						?.scrollIntoView({block: 'nearest'});
				}
			} else if (origin.current !== undefined) {
				const target = canFocus(origin.current)
					? origin.current
					: fallback?.current;
				if (canFocus(target)) {
					origin.current = undefined;
					target.focus();
				} else if (!busy) {
					origin.current = undefined;
				}
			}
			previous.current = firstId;
		};
		focus();
		document.addEventListener('close', focus, true);
		return () => document.removeEventListener('close', focus, true);
	}, [requests, answering, busy, questionId, fallback]);

	return {container, dialogs, collapsedFocus};
}

function OptionButtons({
	request,
	answering,
	choose,
}: {
	request: PermissionRequestInfo;
	answering: boolean;
	choose(request: PermissionRequestInfo, optionId: string): void;
}) {
	return (
		<div className="approval-key-hints">
			{request.options.map((option, index) => {
				const shortcut = index < 9 ? String(index + 1) : undefined;
				return (
					<Button
						key={option.id}
						variant={
							request.question || option.kind === 'allow_always'
								? 'default'
								: option.kind.startsWith('allow')
									? 'allow'
									: 'reject'
						}
						keyHint={shortcut ?? keyHint('⏎')}
						aria-keyshortcuts={shortcut}
						disabled={answering}
						onClick={() => choose(request, option.id)}
					>
						{option.name}
					</Button>
				);
			})}
		</div>
	);
}

function SourceLine({
	request,
	id,
	className,
}: {
	request: PermissionRequestInfo;
	id: string;
	className: string;
}) {
	if (request.source?.kind !== 'subagent') return null;
	return (
		<p id={`${id}-source`} className={className}>
			subagent approval · parent run not reported; an approved tool may still
			fail afterwards
		</p>
	);
}

function PermissionCard({
	request,
	position,
	total,
	mode,
	dialogRef,
	answering,
	error,
	choose,
}: {
	request: PermissionRequestInfo;
	position: number;
	total: number;
	mode: NanocoderMode;
	dialogRef: React.Ref<HTMLDivElement>;
	answering: boolean;
	error: string | undefined;
	choose(request: PermissionRequestInfo, optionId: string): void;
}) {
	const id = React.useId();
	const question = request.question === true;
	const tool = question ? undefined : reportedToolName(request.title);
	const policy =
		!question && request.options.some(option => option.kind === 'allow_always');
	const describedBy = [
		`${id}-meta`,
		`${id}-command`,
		`${id}-effect`,
		...(request.source?.kind === 'subagent' ? [`${id}-source`] : []),
		...(policy ? [`${id}-policy`] : []),
	].join(' ');
	return (
		<Card
			variant="approval"
			aria-label={`permission request ${position} of ${total}`}
		>
			<div
				ref={dialogRef}
				className="approval-dialog"
				role="alertdialog"
				aria-modal="false"
				aria-labelledby={`${id}-title`}
				aria-describedby={describedBy}
				tabIndex={-1}
				onKeyDown={event => {
					if (answering) return;
					const option = shortcutOption(event, request.options);
					if (!option) return;
					event.preventDefault();
					choose(request, option.id);
				}}
			>
				<h2 id={`${id}-title`}>
					<span aria-hidden="true">▲ </span>
					{question ? QUESTION_TITLE : 'approval required'}
				</h2>
				<p id={`${id}-meta`} className="approval-meta">
					{[question ? 'ask_user' : 'Nanocoder', tool, `${mode} mode`]
						.filter(Boolean)
						.join(' · ')}
				</p>
				{question ? (
					<p id={`${id}-command`} className="approval-question">
						{request.title}
					</p>
				) : (
					<p id={`${id}-command`} className="approval-command">
						<code>{request.title}</code>
					</p>
				)}
				<p id={`${id}-effect`} className="approval-effect">
					{question
						? 'ACP supports selectable options only. no free-text answer is invented.'
						: APPROVAL_EFFECT}
				</p>
				<SourceLine request={request} id={id} className="approval-effect" />
				<OptionButtons
					request={request}
					answering={answering}
					choose={choose}
				/>
				{!request.options.length && <p>{NO_OPTIONS}</p>}
				{policy && (
					<p id={`${id}-policy`} className="approval-policy">
						{POLICY_NOTE}
					</p>
				)}
				{error && <p role="alert">{error}</p>}
			</div>
		</Card>
	);
}

function focusables(dialog: HTMLDialogElement) {
	return [
		...dialog.querySelectorAll<HTMLElement>('button:not(:disabled)'),
	].filter(canFocus);
}

function QuestionDialog({
	request,
	answering,
	error,
	choose,
	dismiss,
}: {
	request: PermissionRequestInfo;
	answering: boolean;
	error: string | undefined;
	choose(request: PermissionRequestInfo, optionId: string): void;
	dismiss(): void;
}) {
	const id = React.useId();
	const dialog = React.useRef<HTMLDialogElement>(null);
	const close = React.useRef<HTMLButtonElement>(null);
	React.useLayoutEffect(() => {
		const node = dialog.current;
		if (node && !node.open) node.showModal();
		close.current?.focus();
	}, []);
	React.useLayoutEffect(() => {
		const node = dialog.current;
		if (!answering && node?.open && !node.contains(document.activeElement))
			close.current?.focus();
	}, [answering]);
	return (
		<dialog
			ref={dialog}
			className="question-dialog"
			role="alertdialog"
			aria-modal="true"
			aria-labelledby={`${id}-title`}
			aria-describedby={[
				`${id}-meta`,
				`${id}-question`,
				...(request.source?.kind === 'subagent' ? [`${id}-source`] : []),
			].join(' ')}
			onCancel={event => {
				event.preventDefault();
				dismiss();
			}}
			// Escape can close a modal dialog without a cancelable cancel event.
			onClose={dismiss}
			onKeyDown={event => {
				if (event.key === 'Escape') {
					event.preventDefault();
					dismiss();
					return;
				}
				if (event.key === 'Tab' && dialog.current) {
					const items = focusables(dialog.current);
					const first = items[0];
					const last = items.at(-1);
					if (!first || !last) return;
					const active = document.activeElement;
					if (event.shiftKey ? active === first : active === last) {
						event.preventDefault();
						(event.shiftKey ? last : first).focus();
					} else if (!dialog.current.contains(active)) {
						event.preventDefault();
						first.focus();
					}
					return;
				}
				if (answering) return;
				const option = shortcutOption(event, request.options);
				if (!option) return;
				event.preventDefault();
				choose(request, option.id);
			}}
		>
			<div data-stream-announcement-host="modal" />
			<div className="question-dialog-head">
				<h2 id={`${id}-title`}>{QUESTION_TITLE}</h2>
				<Button
					ref={close}
					className="question-dialog-close"
					aria-label="close choice"
					onClick={dismiss}
				>
					×
				</Button>
			</div>
			<div className="question-dialog-body">
				<p id={`${id}-meta`} className="question-dialog-meta">
					{QUESTION_META}
				</p>
				<p id={`${id}-question`} className="question-dialog-prompt">
					{request.title}
				</p>
				<SourceLine request={request} id={id} className="approval-effect" />
				<div className="question-choices">
					{request.options.map((option, index) => {
						const shortcut = index < 9 ? String(index + 1) : undefined;
						return (
							<button
								key={option.id}
								type="button"
								className="question-choice"
								aria-keyshortcuts={shortcut}
								disabled={answering}
								onClick={() => choose(request, option.id)}
							>
								<span aria-hidden="true">{index + 1} · </span>
								{option.name}
							</button>
						);
					})}
				</div>
				{!request.options.length && <p>{NO_OPTIONS}</p>}
				{error && <p role="alert">{error}</p>}
			</div>
		</dialog>
	);
}

export function ApprovalRequests({
	requests,
	mode,
	busy,
	fallbackFocus,
	onAnswer,
}: {
	requests: readonly PermissionRequestInfo[];
	mode: NanocoderMode;
	busy: boolean;
	fallbackFocus?: React.RefObject<HTMLElement | null>;
	onAnswer(id: string, optionId: string): Promise<IpcResult<null>>;
}) {
	const pending = React.useRef(false);
	const [answering, setAnswering] = React.useState(false);
	const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const questionId = openQuestionId(requests, collapsed);
	const {container, dialogs, collapsedFocus} = useApprovalFocus(
		requests,
		answering,
		busy,
		questionId,
		fallbackFocus,
	);
	const [error, setError] = React.useState<{
		id: string;
		message: string;
	} | null>(null);
	const choose = async (request: PermissionRequestInfo, optionId: string) => {
		if (pending.current) return;
		pending.current = true;
		setAnswering(true);
		setError(null);
		try {
			const result = await onAnswer(request.id, optionId);
			if (!result.ok) setError({id: request.id, message: result.error.message});
		} catch {
			setError({
				id: request.id,
				message: 'could not send this choice. try again.',
			});
		} finally {
			pending.current = false;
			setAnswering(false);
		}
	};
	const collapse = (id: string) => {
		collapsedFocus.current = id;
		setCollapsed(current => {
			if (current.has(id)) return current;
			const live = new Set(requests.map(request => request.id));
			return new Set([...current].filter(entry => live.has(entry)).concat(id));
		});
	};
	return requests.length ? (
		<div className="approval-requests" ref={container}>
			{requests.map((request, index) =>
				request.id === questionId ? (
					<QuestionDialog
						key={request.id}
						request={request}
						answering={answering}
						error={error?.id === request.id ? error.message : undefined}
						choose={(request, optionId) => {
							void choose(request, optionId);
						}}
						dismiss={() => collapse(request.id)}
					/>
				) : (
					<PermissionCard
						key={request.id}
						request={request}
						position={index + 1}
						total={requests.length}
						mode={mode}
						dialogRef={node => {
							if (node) dialogs.current.set(request.id, node);
							else dialogs.current.delete(request.id);
						}}
						answering={answering}
						error={error?.id === request.id ? error.message : undefined}
						choose={(request, optionId) => {
							void choose(request, optionId);
						}}
					/>
				),
			)}
		</div>
	) : null;
}
