import {expect, type Locator} from '@playwright/test';

export async function choose(
	combobox: Locator,
	option: string | {label: string},
): Promise<void> {
	await combobox.click();
	const list = combobox.locator('xpath=..').getByRole('listbox');
	const target =
		typeof option === 'string'
			? list.locator(`[role="option"][data-value="${option}"]`)
			: list.getByRole('option', {name: option.label, exact: true});
	await target.click();
}

export async function expectValue(
	combobox: Locator,
	value: string,
): Promise<void> {
	await expect(combobox).toHaveAttribute('data-value', value);
}
