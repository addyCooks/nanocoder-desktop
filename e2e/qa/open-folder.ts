import {realpathSync} from 'node:fs';
import path from 'node:path';
import {expect, type Page} from '@playwright/test';

// Starts the open-folder command from the header palette and waits for the palette to close.
// The welcome button exists only before a thread is open, so the palette is the entry in a thread.
export async function startFolderFromPalette(page: Page): Promise<void> {
	const palette = page.getByRole('dialog', {
		name: 'command palette',
		exact: true,
	});
	const trigger = page.getByRole('button', {
		name: 'command palette',
		exact: true,
	});
	const command = page.getByRole('option', {name: /open a project folder/});
	const search = page.getByRole('combobox', {
		name: 'find a thread or action',
		exact: true,
	});
	await trigger.click();
	await search.fill('open a project folder');
	await expect(command).not.toHaveAttribute('aria-disabled', 'true');
	await expect(search).toHaveAttribute(
		'aria-activedescendant',
		'palette-option-action-open-folder',
	);
	await page.keyboard.press('Enter');
	await expect(palette).toBeHidden();
}

// Opens a folder and waits for its own outcome: the folder is the selected project and shows ACP ready or its own retry.
// A refused folder shows the refusal that names it. A policy refusal passes the alert text it must show.
// Other alerts and badges on the page never count.
export async function openFolderFromPalette(
	page: Page,
	folder: string,
	result: 'opened' | 'refused' | {alert: string} = 'opened',
): Promise<void> {
	await startFolderFromPalette(page);
	if (typeof result !== 'string') {
		await expect(
			page.getByRole('alert').filter({hasText: result.alert}).first(),
		).toBeVisible();
	} else if (result === 'refused') {
		await expect(
			page
				.getByRole('alert')
				.filter({hasText: 'not opened'})
				.filter({hasText: path.basename(folder)})
				.first(),
		).toBeVisible();
	} else {
		await expect(page.locator('.project-switch-root').first()).toHaveText(
			realpathSync.native(folder),
		);
		await expect(
			page
				.locator('.footer-acp--success')
				.or(page.getByRole('button', {name: 'retry Nanocoder', exact: true}))
				.first(),
		).toBeVisible();
	}
	const palette = page.getByRole('dialog', {
		name: 'command palette',
		exact: true,
	});
	const trigger = page.getByRole('button', {
		name: 'command palette',
		exact: true,
	});
	const command = page.getByRole('option', {name: /open a project folder/});
	const search = page.getByRole('combobox', {
		name: 'find a thread or action',
		exact: true,
	});
	await trigger.click();
	await search.fill('open a project folder');
	await expect(command).not.toHaveAttribute('aria-disabled', 'true');
	await page.keyboard.press('Escape');
	await expect(palette).toBeHidden();
}
