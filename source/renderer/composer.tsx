import * as React from 'react';
import type {AttachmentChip} from '@/renderer/attachments';
import {composerEnter} from '@/renderer/composer-key';
import {Dropdown} from '@/renderer/dropdown';
import {Icon} from '@/renderer/icons';
import {keyHint} from '@/renderer/overlay-model';
import {SlashSuggestions} from '@/renderer/stream-commands';
import type {Transcript} from '@/renderer/transcript';
import {Button} from '@/renderer/ui';
import type {
	DefaultMode,
	NanocoderMode,
	ProjectConfigSelect,
	ProjectControls,
	StreamCommand,
} from '@/shared/ipc';

export interface ComposerProps {
	draft: string;
	editable: boolean;
	sendReason: string | null;
	controlReason: string | null;
	projectName: string;
	projectControls: ProjectControls | null;
	mode: NanocoderMode;
	defaultMode: DefaultMode;
	modePending: boolean;
	running: boolean;
	stopping: boolean;
	error?: string | null;
	commands: readonly StreamCommand[];
	context?: Transcript['context'];
	attachments?: readonly AttachmentChip[];
	onRemoveAttachment?(id: string): void;
	inputRef?: React.RefObject<HTMLTextAreaElement | null>;
	onDraft(value: string): void;
	onSend(): void;
	onCancel(): void;
	onMode(mode: NanocoderMode): void;
	onDefault(mode: DefaultMode): void;
	onConfig(id: ProjectConfigSelect['id'], value: string): void;
}

const modes: NanocoderMode[] = [
	'normal',
	'auto-accept',
	'yolo',
	'plan',
	'architect',
];

export function Composer(props: ComposerProps) {
	const localInput = React.useRef<HTMLTextAreaElement>(null);
	const input = props.inputRef ?? localInput;
	React.useLayoutEffect(() => {
		const element = input.current;
		if (!element || element.value !== props.draft) return;
		element.style.height = 'auto';
		element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
	}, [input, props.draft]);
	const id = React.useId();
	const descriptionId = `${id}-description`;
	const helpId = `${id}-help`;
	const noteId = `${id}-note`;
	const optionsId = `${id}-options`;
	const [optionsOpen, setOptionsOpen] = React.useState(false);
	const defaultHintId = `${id}-default`;
	const missingOffers =
		'available after the first message: Nanocoder supplies model options after a session exists';
	const options = props.projectControls?.configOptions ?? [];
	const ownModel = props.projectControls?.modelScope === 'thread';
	const modelTarget = ownModel
		? `this thread in project ${props.projectName}`
		: `every thread in project ${props.projectName}`;
	const modelReason =
		props.controlReason ??
		(!props.projectControls?.modelGate.enabled
			? (props.projectControls?.modelGate.reason ?? missingOffers)
			: options.length
				? null
				: missingOffers);
	const modeReason =
		props.controlReason ??
		(!props.editable ? 'this thread cannot change mode yet' : null);
	const defaultReason =
		modeReason ??
		(props.mode === 'yolo'
			? 'yolo cannot be a project default'
			: props.mode === props.defaultMode
				? 'already the project default'
				: null);
	const sendReason =
		props.sendReason ??
		(!props.editable ? 'this thread cannot accept input' : null);
	const emptyDraft = !props.draft.trim();
	const send = () => {
		if (!sendReason && !emptyDraft) props.onSend();
	};
	const hint =
		sendReason ??
		(props.running
			? 'turn in progress · draft is not queued'
			: 'ready for your next message');
	const idleEmpty = !props.running && !sendReason && emptyDraft;
	const description = idleEmpty ? `${hint}; enter a message to send` : hint;
	const lead = modelReason ?? modeReason;
	const note = [
		lead && `${lead.replace(/\.$/, '')}.`,
		`model applies to ${ownModel ? 'this thread only' : `every thread in ${props.projectName}`}. tools in Nanocoder's alwaysAllow list still run without asking.`,
	]
		.filter(Boolean)
		.join(' ');
	const context =
		props.context &&
		Number.isFinite(props.context.used) &&
		props.context.used >= 0 &&
		Number.isFinite(props.context.size) &&
		props.context.size > 0
			? props.context
			: undefined;
	const percentage = context
		? Math.min(100, Math.round((context.used / context.size) * 100))
		: 0;
	return (
		<>
			<div className="composer-hint-row">
				<p className="gate-hint">{hint}</p>
				{props.running && (
					<Button
						variant="reject"
						className="composer-cancel"
						disabled={props.stopping}
						onClick={props.onCancel}
					>
						{props.stopping ? 'cancelling turn' : 'cancel turn'}
					</Button>
				)}
			</div>
			<form
				className="gate-composer composer"
				aria-label="composer"
				data-unavailable={!props.editable || undefined}
				onSubmit={event => {
					event.preventDefault();
					send();
				}}
			>
				<span id={descriptionId} className="sr-only" aria-hidden="true">
					{description}
				</span>
				{props.attachments && props.attachments.length > 0 && (
					<ul
						className="composer-attachments"
						aria-label="attached to your next message"
					>
						{props.attachments.map(chip => (
							<li key={chip.id} className="composer-chip">
								<span className="composer-chip-label">{chip.label}</span>
								<button
									type="button"
									className="composer-chip-remove"
									aria-label={`remove ${chip.label}`}
									onClick={() => props.onRemoveAttachment?.(chip.id)}
								>
									remove
								</button>
							</li>
						))}
					</ul>
				)}
				<label className="composer-message">
					<span className="sr-only">message</span>
					<textarea
						className="composer-inactive-control"
						ref={input}
						value={props.draft}
						onChange={event => props.onDraft(event.currentTarget.value)}
						onKeyDown={event => {
							if (
								composerEnter({
									key: event.key,
									shiftKey: event.shiftKey,
									altKey: event.altKey,
									ctrlKey: event.ctrlKey,
									metaKey: event.metaKey,
									isComposing: event.nativeEvent.isComposing,
									keyCode: event.nativeEvent.keyCode,
								})
							) {
								event.preventDefault();
								send();
							}
						}}
						disabled={!props.editable}
						placeholder={
							props.running ? 'write a draft for later…' : 'ask anything…'
						}
						aria-describedby={`${descriptionId} ${helpId}`}
						rows={2}
					/>
				</label>
				<SlashSuggestions
					commands={props.commands}
					draft={props.draft}
					disabled={!props.editable}
					onInsert={value => {
						props.onDraft(value);
						props.inputRef?.current?.focus();
					}}
				/>
				<div className="composer-control-rail">
					{options.length ? (
						options.map(option => (
							<Dropdown
								key={option.id}
								className={`composer-pill${option.id === 'model' ? ' composer-model' : ''}`}
								placement="up"
								aria-label={`${option.id} for ${modelTarget}`}
								aria-describedby={noteId}
								value={option.currentValue}
								disabled={!!modelReason}
								options={option.options.map(value => ({
									value: value.value,
									label: value.name,
								}))}
								onChange={value => props.onConfig(option.id, value)}
							/>
						))
					) : (
						<Button
							disabled
							aria-label={`model and provider for ${modelTarget}`}
							aria-describedby={noteId}
						>
							model · after first message
						</Button>
					)}
					<Dropdown
						className="composer-pill composer-mode"
						placement="up"
						aria-label="mode for this thread"
						aria-describedby={noteId}
						value={props.mode}
						disabled={!!modeReason}
						options={modes.map(mode => ({value: mode, label: mode}))}
						onChange={value => props.onMode(value as NanocoderMode)}
					/>
					<button
						type="button"
						className="composer-options-toggle"
						aria-label="mode and project default details"
						title="mode and project default"
						aria-expanded={optionsOpen}
						aria-controls={optionsId}
						onClick={() => setOptionsOpen(open => !open)}
					>
						<Icon name="more" size={16} />
					</button>
					{context && (
						<span className="composer-pill composer-context">
							ctx {percentage}%
						</span>
					)}
					<Button
						className="composer-send"
						type="submit"
						aria-label="send"
						data-state={
							props.running
								? 'running'
								: props.editable
									? 'ready'
									: 'unavailable'
						}
						disabled={!!sendReason || emptyDraft}
						aria-describedby={descriptionId}
					>
						<Icon name="send" size={18} />
					</Button>
				</div>
				<p id={helpId} className="sr-only composer-help">
					<span>{keyHint('↵ send · ⇧↵ newline')}</span>
					{props.commands.length > 0 && <span>/ advertised commands</span>}
				</p>
				{props.error && <p role="alert">{props.error}</p>}
				{context && (
					<div
						className="composer-context-gauge"
						role="progressbar"
						aria-label="reported context use"
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={percentage}
						aria-valuetext={`${context.used} of ${context.size} reported context tokens`}
					>
						<span style={{width: `${percentage}%`}} />
					</div>
				)}
			</form>
			<div className="composer-options">
				<p className="sr-only">
					<span id={noteId}>{note}</span>
				</p>
				{props.modePending && (
					<p className="sr-only">{props.mode} · pending first message.</p>
				)}
				<div id={optionsId} className="gate-actions" hidden={!optionsOpen}>
					<Button
						disabled={!!defaultReason}
						aria-describedby={defaultHintId}
						onClick={() => {
							if (!defaultReason && props.mode !== 'yolo')
								props.onDefault(props.mode);
						}}
					>
						use as this project's default
					</Button>
					<p id={defaultHintId} className="gate-hint">
						project default: {props.defaultMode}
						{defaultReason ? ` · ${defaultReason}` : ''}
					</p>
				</div>
			</div>
		</>
	);
}
