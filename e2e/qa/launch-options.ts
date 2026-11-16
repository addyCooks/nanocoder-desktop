import {E2E_HIDDEN_SWITCH} from '@/main/window-presentation';

// The suite compares computed styles with whole CSS pixels, which only hold at a display scale of 1.
export const FIXED_SCALE_SWITCH = '--force-device-scale-factor=1';

export function e2eArguments(
	args: readonly string[],
	visible = process.env.NANOCODER_E2E_VISIBLE,
): string[] {
	const normal = args.filter(
		arg => arg !== E2E_HIDDEN_SWITCH && arg !== FIXED_SCALE_SWITCH,
	);
	return visible === '1'
		? normal
		: [...normal, FIXED_SCALE_SWITCH, E2E_HIDDEN_SWITCH];
}
