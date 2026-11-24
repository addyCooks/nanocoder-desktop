import {expect, type Page} from '@playwright/test';

// Opens the saved-session page from the command palette and waits for the palette to close.
// The page focuses its first offered row, or refresh when none is offered.
export async function openImportsFromPalette(page: Page): Promise<void> {
	const palette = page.getByRole('dialog', {
		name: 'command palette',
		exact: true,
	});
	const trigger = page.getByRole('button', {
		name: 'command palette',
		exact: true,
	});
	const search = page.getByRole('combobox', {
		name: 'find a thread or action',
		exact: true,
	});
	await trigger.click();
	await search.fill('import saved sessions');
	await expect(
		page.getByRole('option', {name: /import saved sessions/}),
	).not.toHaveAttribute('aria-disabled', 'true');
	await page.keyboard.press('Enter');
	await expect(palette).toBeHidden();
}
