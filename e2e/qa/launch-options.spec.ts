import {readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import test from 'ava';
import {E2E_HIDDEN_SWITCH} from '@/main/window-presentation';
import {e2eArguments, FIXED_SCALE_SWITCH} from './launch-options';

test('routine e2e arguments always request hidden windows at a display scale of 1 without mutating inputs', t => {
	const args = ['.', '--user-data-dir=/temporary/profile'];
	const routine = [...args, FIXED_SCALE_SWITCH, E2E_HIDDEN_SWITCH];
	t.deepEqual(e2eArguments(args, undefined), routine);
	t.deepEqual(args, ['.', '--user-data-dir=/temporary/profile']);
	t.deepEqual(e2eArguments(args, '0'), routine);
	t.deepEqual(e2eArguments(routine, undefined), routine);
});

test('visible windows require the exact explicit manual-QA opt-in and keep the real display scale', t => {
	t.deepEqual(e2eArguments(['.'], '1'), ['.']);
	t.deepEqual(e2eArguments(['.', E2E_HIDDEN_SWITCH], '1'), ['.']);
	t.deepEqual(e2eArguments(['.', FIXED_SCALE_SWITCH], '1'), ['.']);
	t.deepEqual(e2eArguments(['.', E2E_HIDDEN_SWITCH], '0'), [
		'.',
		FIXED_SCALE_SWITCH,
		E2E_HIDDEN_SWITCH,
	]);
});

test('all e2e and QA launches use the shared Electron launcher', t => {
	const root = path.resolve(import.meta.dirname, '..');
	const bypasses = readdirSync(root, {recursive: true, encoding: 'utf8'})
		.filter(name => name.endsWith('.ts') && !name.endsWith('.spec.ts'))
		.filter(name => name !== path.join('qa', 'electron.ts'))
		.filter(name => {
			const source = readFileSync(path.join(root, name), 'utf8');
			return [
				...source.matchAll(
					/\bimport\s+[\s\S]*?from\s*['"]@playwright\/test['"]/g,
				),
			].some(match => /\b_electron\b/.test(match[0]));
		});
	t.deepEqual(bypasses, []);
});
