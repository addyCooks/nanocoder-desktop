import {z} from 'zod';
import {IpcFailure} from '@/main/ipc/handle-request';
import {MAX_CLIPBOARD_LENGTH} from '@/shared/ipc';

export const clipboardWriteSchema = z.strictObject({
	text: z.string().min(1).max(MAX_CLIPBOARD_LENGTH),
});

export async function writeClipboard(
	request: z.infer<typeof clipboardWriteSchema>,
	write: (text: string) => void | Promise<void>,
): Promise<null> {
	try {
		await write(request.text);
		return null;
	} catch {
		throw new IpcFailure('UNAVAILABLE', 'Clipboard write failed', true);
	}
}
