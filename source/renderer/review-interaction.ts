import type {DiffCursor, LineSelection} from '@/renderer/diff-parse';
import {MAX_REVIEW_EXCERPT, MAX_REVIEW_LINE_SPAN} from '@/shared/ipc';

export function reviewSelectionReason(selection: LineSelection): string | null {
	if (selection.endLine - selection.startLine > MAX_REVIEW_LINE_SPAN)
		return 'select a smaller range: the line-number span must not exceed 2,000.';
	if (selection.excerpt.length > MAX_REVIEW_EXCERPT)
		return 'select a smaller range: a comment excerpt can contain at most 20,000 characters.';
	return null;
}

export interface ReviewInteractionIdentity {
	projectId: string | null;
	path: string;
	staged: boolean;
	agent: boolean;
}

export interface ReviewInteraction {
	cursor: DiffCursor | null;
	cursorFingerprint: string | null;
	comment: string;
}

export type ReviewInteractions = Readonly<
	Record<string, ReviewInteraction | undefined>
>;

export const emptyInteraction: ReviewInteraction = {
	cursor: null,
	cursorFingerprint: null,
	comment: '',
};

export function interactionKey(identity: ReviewInteractionIdentity): string {
	return JSON.stringify([
		identity.projectId,
		identity.path,
		identity.staged,
		identity.agent,
	]);
}

export function interactionFor(
	drafts: ReviewInteractions,
	identity: ReviewInteractionIdentity,
	fingerprint?: string,
): ReviewInteraction {
	const saved = drafts[interactionKey(identity)] ?? emptyInteraction;
	return fingerprint !== undefined && saved.cursorFingerprint !== fingerprint
		? {...saved, cursor: null, cursorFingerprint: null}
		: saved;
}

export function storeInteraction(
	drafts: ReviewInteractions,
	identity: ReviewInteractionIdentity,
	interaction: ReviewInteraction,
): ReviewInteractions {
	return {...drafts, [interactionKey(identity)]: interaction};
}
