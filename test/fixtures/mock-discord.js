'use strict';
// Preloaded (node -r) into a child `node bot.js` by test/bot-smoke.test.js: replaces discord.js's Client with an in-memory fake
// so the real bot.js wiring (config, settings, pipeline, health file, slash-command registration + handling, webhook POST)
// can be exercised without any network access to Discord.
const Module = require('module');
const EventEmitter = require('events');
const real = require('discord.js');

const BOT = '999999999999999999', OWNER = process.env.MOCK_OWNER_ID, STRANGER = '300000000000000002';
const now = () => Date.now();
const mkMsg = (id, authorId, username, content, guild) => ({
  id, channelId: guild ? '500000000000000001' : '800000000000000001', guildId: guild ? '600000000000000001' : null,
  guild: guild ? { id: '600000000000000001', name: 'Mock Guild' } : null,
  channel: { id: guild ? '500000000000000001' : '800000000000000001', name: 'general', type: guild ? 0 : 1, sendTyping: async () => { console.log('MOCK typing'); } },
  author: { id: authorId, username, bot: false }, content, webhookId: null, attachments: new Map(),
  mentions: { users: new Map(), channels: new Map(), roles: new Map(), has: (i) => guild && i === BOT },
  reference: null, createdTimestamp: now(), createdAt: new Date(), react: async (e) => { console.log(`MOCK react ${e}`); },
});
const mkInteraction = (userId, group, sub) => ({
  user: { id: userId }, commandName: 'bridge', deferred: false,
  isChatInputCommand: () => true,
  options: { getSubcommandGroup: () => group, getSubcommand: () => sub, getString: () => null, getInteger: () => null, getBoolean: () => null, getUser: () => null, getChannel: () => null },
  reply: async (b) => { console.log(`MOCK reply to=${userId === OWNER ? 'owner' : 'stranger'} flags=${b.flags} ${JSON.stringify(b.content).slice(0, 400)}`); },
  deferReply: async () => {}, editReply: async () => {},
});

class Client extends EventEmitter {
  constructor(opts) {
    super();
    console.log(`MOCK intents=${opts.intents.length}`);
    this.user = null;
    this.ws = { status: 0, destroyed: false, ping: 42, shards: new Map([[0, { status: 0, ping: 42, lastPingTimestamp: now() }]]) };
    this.guilds = { cache: new Map() };
    this.channels = { cache: new Map(), fetch: async () => null };
    this.users = { createDM: async () => null, fetch: async () => ({ send: async () => {} }) };
    this.application = { commands: { set: async (defs) => { console.log(`MOCK commands.set count=${defs.length} name=${defs[0].name}`); return []; } } };
    this.rest = { get: async () => ({ items: [] }) };
  }
  async login(token) {
    console.log(`MOCK login tokenLen=${token.length}`);
    this.user = { id: BOT, tag: 'MockBot#0000', setPresence: (p) => { console.log(`MOCK presence ${p.status}`); } };
    setTimeout(() => {
      this.emit('clientReady');
      this.emit('messageCreate', mkMsg('710000000000000001', OWNER, 'owner', 'hello from the owner', false));
      this.emit('messageCreate', mkMsg('710000000000000002', STRANGER, 'rando', 'ultra-secret-text-in-smoke-test', true));
      this.emit('interactionCreate', mkInteraction(OWNER, null, 'status'));
      this.emit('interactionCreate', mkInteraction(STRANGER, null, 'status'));
    }, 100);
  }
  destroy() {}
}

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  const m = origLoad.call(this, request, ...rest);
  return request === 'discord.js' ? { ...real, Client } : m;
};
