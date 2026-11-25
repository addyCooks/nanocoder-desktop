export interface FollowState {
	key: string;
	following: boolean;
}

export type FollowEvent =
	| {type: 'thread'; key: string}
	| {type: 'scroll'; atBottom: boolean}
	| {type: 'latest'};

export function initialFollowState(key: string): FollowState {
	return {key, following: true};
}

export function reduceFollow(
	state: FollowState,
	event: FollowEvent,
): FollowState {
	switch (event.type) {
		case 'thread':
			return initialFollowState(event.key);
		case 'scroll':
			return state.following === event.atBottom
				? state
				: {...state, following: event.atBottom};
		case 'latest':
			return state.following ? state : {...state, following: true};
	}
}
