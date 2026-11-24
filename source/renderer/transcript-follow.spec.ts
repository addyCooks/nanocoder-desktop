import test from 'ava';
import {initialFollowState, reduceFollow} from '@/renderer/transcript-follow';

test('follow starts at the latest row and releases only when the reader leaves the bottom', t => {
	let state = initialFollowState('project:one');
	t.true(state.following);
	state = reduceFollow(state, {type: 'scroll', atBottom: false});
	t.false(state.following);
	t.false(state.following);
	state = reduceFollow(state, {type: 'scroll', atBottom: true});
	t.true(state.following);
});

test('latest resumes following and a thread switch always starts at the end', t => {
	let state = reduceFollow(initialFollowState('project:one'), {
		type: 'scroll',
		atBottom: false,
	});
	state = reduceFollow(state, {type: 'latest'});
	t.true(state.following);
	state = reduceFollow(state, {type: 'scroll', atBottom: false});
	state = reduceFollow(state, {type: 'thread', key: 'project:two'});
	t.deepEqual(state, {key: 'project:two', following: true});
});
