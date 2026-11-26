import {pathToFileURL} from 'node:url';
import type {ContentBlock} from '@agentclientprotocol/sdk';
import {oneLine, PAGE_DATA_LABEL} from '@/main/browser/page-data';
import type {FileService} from '@/main/files/file-service';
import {IpcFailure} from '@/main/ipc/handle-request';
import type {ProjectInfo, PromptAttachment} from '@/shared/ipc';

export interface ResolvedAttachments {
	// Content for this prompt only; nothing here is stored (CHAT-16).
	blocks: ContentBlock[];
	// One line per attachment, shown under the user's message.
	summary: string[];
}

const refuse = (path: string, why: string) =>
	new IpcFailure('VALIDATION', `${path} cannot be attached: ${why}`);

// Files are checked through the file service, so an attachment gets exactly the
// same refusals as the browser: nothing outside the project, nothing in .git,
// no binary or oversized content (FILE-08, SEC-03). With embedded context the
// text travels in the prompt; otherwise Nanocoder reads the linked file back
// through the checked fs/read_text_file handler.
export interface BrowserPages {
	current(projectId: string): {url: string; title: string} | null;
}

export async function resolveAttachments(
	files: FileService,
	project: ProjectInfo,
	attachments: PromptAttachment[],
	embedded: boolean,
	pages?: BrowserPages,
): Promise<ResolvedAttachments> {
	const blocks: ContentBlock[] = [];
	const summary: string[] = [];
	for (const item of attachments) {
		if (item.kind === 'browser-page') {
			if (!pages)
				throw new IpcFailure('VALIDATION', 'The browser page is unavailable');
			const current = pages.current(project.id);
			if (!current)
				throw refuse('browser page', 'no page is open in the browser');
			if (current.url !== item.url)
				throw refuse('browser page', 'the page changed, so send it again');
			blocks.push({
				type: 'text',
				text: `Browser page (${PAGE_DATA_LABEL}):\nTitle: ${oneLine(current.title, 200)}\nURL: ${current.url}`,
			});
			summary.push(`browser page: ${new URL(current.url).host}`);
			continue;
		}
		if (item.kind === 'file') {
			const preview = await files.preview({
				projectId: project.id,
				path: item.path,
			});
			if (preview.kind !== 'text')
				throw refuse(
					item.path,
					preview.detail
						.replace(/\.$/u, '')
						.replace(/^./u, c => c.toLowerCase()),
				);
			const {resolved} = await files.locate(project.id, item.path);
			const uri = pathToFileURL(resolved.real).href;
			blocks.push(
				embedded
					? {
							type: 'resource',
							resource: {uri, mimeType: 'text/plain', text: preview.text},
						}
					: {
							type: 'resource_link',
							uri,
							name: preview.path,
							mimeType: 'text/plain',
							size: preview.size,
						},
			);
			summary.push(`attached: ${preview.path}`);
			continue;
		}
		// A comment may be on a file that was deleted, so the file need not exist,
		// but it gets the same trust, containment and .git refusals as a file.
		if (!item.path) throw refuse(item.path, 'it is not a project file');
		await files.checkPath(project.id, item.path);
		const range =
			item.startLine === item.endLine
				? `line ${item.startLine}`
				: `lines ${item.startLine}-${item.endLine}`;
		const quoted = item.excerpt
			? `${item.excerpt
					.replace(/\r?\n$/u, '')
					.split(/\r?\n/u)
					.map(line => `> ${line}`)
					.join('\n')}\n`
			: '';
		blocks.push({
			type: 'text',
			text: `Review comment on ${item.path}, ${range} (${item.side} changes):\n${quoted}${item.comment}`,
		});
		summary.push(
			`review comment: ${item.path}:${item.startLine}-${item.endLine}`,
		);
	}
	return {blocks, summary};
}
