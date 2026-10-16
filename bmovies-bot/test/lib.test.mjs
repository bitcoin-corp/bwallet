import test from 'node:test';
import assert from 'node:assert/strict';
import { selectBoosts, classifyMentions, maxId } from '../lib.mjs';

const BOT = '900';
const m = (u) => ({ entities: { mentions: [{ username: u }] } });
const tweets = [
  { id: '1', author_id: '10', text: 'new film @bmovies_app', ...m('bmovies_app') },
  { id: '2', author_id: '10', text: 'nothing here' },
  { id: '3', author_id: '10', text: 'RT @bmovies_app', ...m('bmovies_app'), referenced_tweets: [{ type: 'retweeted', id: '7' }] },
  { id: '4', author_id: '10', text: '@bmovies_app thanks', ...m('BMOVIES_APP'), in_reply_to_user_id: BOT },
  { id: '5', author_id: BOT, text: '@bmovies_app self', ...m('bmovies_app') },
  { id: '1', author_id: '10', text: 'dup @bmovies_app', ...m('bmovies_app') },
  { id: '6', author_id: '10', text: 'plain text mention @bMovies_App!' },
];

test('selectBoosts: mention only, no retweets, no replies to bot, no self, dedupe', () => {
  assert.deepEqual(selectBoosts(tweets, { botId: BOT }).map((t) => t.id), ['1', '6']);
});
test('selectBoosts: never twice', () => {
  assert.deepEqual(selectBoosts(tweets, { botId: BOT, done: { 1: {}, 6: {} } }), []);
});
test('classifyMentions: allowlist approved, others pending, snippet only', () => {
  const users = [{ id: '10', username: 'b0aseX' }, { id: '11', username: 'fan' }, { id: '12', username: 'friend' }];
  const ms = [
    { id: '20', author_id: '10', text: 'hi @bmovies_app' },
    { id: '21', author_id: '11', text: 'x'.repeat(400), attachments: { media_keys: ['m'] } },
    { id: '22', author_id: '12', text: 'yo' },
    { id: '23', author_id: BOT, text: 'self' },
  ];
  const q = classifyMentions(ms, { users, botId: BOT, allowlist: ['Friend'], queue: { 22: {} } });
  assert.deepEqual(q.map((i) => [i.id, i.status]), [['20', 'approved'], ['21', 'pending']]);
  assert.equal(q[1].text.length, 280);
  assert.equal(q[1].url, 'https://x.com/fan/status/21');
  assert.ok(!('attachments' in q[1]) && !('media' in q[1]));
});
test('maxId compares as big integers', () => {
  assert.equal(maxId('999', '1000'), '1000');
  assert.equal(maxId(null, '5'), '5');
});
