// What each simulated bot is sent, and what a correct Shardlens install records for it: counts by command (or custom
// ID) and outcome, and the servers that added and removed the bot.

function tally() {
  const e = {
    prefix: {},
    chat_input: {},
    user_context: {},
    message_context: {},
    components: {},
    modalsShown: {},
    modalsSubmitted: {},
    autocomplete: {},
    growth: { servers: { joins: 0, leaves: 0 } },
  };
  const by = (bucket) => (name, outcome) => {
    e[bucket][name] ??= {};
    e[bucket][name][outcome] = (e[bucket][name][outcome] ?? 0) + 1;
  };
  return {
    prefix: by('prefix'),
    slash: by('chat_input'),
    userMenu: by('user_context'),
    messageMenu: by('message_context'),
    component: by('components'),
    modalShown: (id) => by('modalsShown')(id, 'shown'),
    modalSubmitted: by('modalsSubmitted'),
    autocomplete: (name) => by('autocomplete')(name, 'ok'),
    join: () => e.growth.servers.joins++,
    leave: () => e.growth.servers.leaves++,
    done: () => e,
  };
}

async function waitFor(fn, ms = 3_000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const customIds = (message) =>
  (message.components ?? []).flatMap((row) => (row.components ?? []).map((c) => c.custom_id));

export const scenarios = {
  'js-prefix': {
    appId: '1100000000000000001',
    async run(w) {
      const E = tally();
      const [g1, g2, g3] = w.guilds;
      const U = w.users;
      const [admin, admin2] = U;

      for (let i = 0; i < 12; i++) {
        w.say(U[2 + (i % 8)], g1, i % 3 === 0 ? '!p' : '!ping');
        E.prefix('ping', 'ok');
        await w.sleep(40);
      }
      // A per-server prefix: from now on only `?` works in server 2.
      w.say(admin, g2, '!prefix ?');
      E.prefix('prefix', 'ok');
      await w.sleep(300);
      for (let i = 0; i < 6; i++) {
        w.say(U[3 + i], g2, '?ping');
        E.prefix('ping', 'ok');
        await w.sleep(40);
      }
      // Not a command any more in server 2: not recorded.
      w.say(U[4], g2, '!ping');

      for (let i = 0; i < 5; i++) {
        w.say(i % 2 ? admin : admin2, g1, `!ban <@${U[9].id}> spamming the secret plan`);
        E.prefix('ban', 'ok');
        await w.sleep(40);
      }
      for (let i = 0; i < 3; i++) {
        w.say(admin, g3, '!b');
        E.prefix('ban', 'error');
        await w.sleep(40);
      }
      for (let i = 0; i < 4; i++) {
        w.say(U[5 + i], g1, '!yeet someone');
        E.prefix('ban', 'ok');
        await w.sleep(40);
      }

      for (let i = 0; i < 4; i++) {
        const before = new Set(w.botMessagesIn(g1.channels[0].id).map((m) => m.id));
        w.say(admin, g1, `!w <@${U[10].id}>`);
        E.prefix('warn', 'ok');
        const reply = await waitFor(() =>
          w.botMessagesIn(g1.channels[0].id).find((m) => !before.has(m.id) && customIds(m).length > 0),
        );
        w.component(admin, g1, reply, customIds(reply)[0]);
        E.component('confirm:warn:*', 'ok');
        await w.sleep(60);
      }

      // Chat that isn't a command: not recorded.
      for (let i = 0; i < 5; i++) w.say(U[11], g1, 'hello there, just chatting about my secret plan');

      for (let i = 0; i < 3; i++) {
        w.say(U[12], null, '!ping');
        E.prefix('ping', 'ok');
        await w.sleep(40);
      }

      for (let i = 0; i < 8; i++) {
        w.slash(U[i % 6], g1, 'info');
        E.slash('info', 'ok');
        await w.sleep(40);
      }
      for (let i = 0; i < 4; i++) {
        w.slash(U[i], g3, 'broken');
        E.slash('broken', 'error');
        await w.sleep(40);
      }

      w.joinGuild();
      E.join();
      await w.sleep(300);
      w.leaveGuild(g3);
      E.leave();
      await w.sleep(2_000);
      return E.done();
    },
  },

  'ts-guide': {
    appId: '1100000000000000002',
    registered: [
      ['ping', 1],
      ['ticket', 1],
      ['feedback', 1],
      ['report', 1],
      ['crash', 1],
      ['privacy', 1],
      ['Profile', 2],
      ['Quote', 3],
    ],
    async run(w) {
      const E = tally();
      const [g1, g2, g3] = w.guilds;
      const U = w.users;

      for (let i = 0; i < 10; i++) {
        w.slash(U[i % 7], i % 2 ? g2 : g1, 'ping');
        E.slash('ping', 'ok');
        await w.sleep(40);
      }

      for (let i = 0; i < 6; i++) {
        const u = U[2 + i];
        w.autocomplete(u, g1, 'ticket', [
          { type: 1, name: 'open', options: [{ type: 3, name: 'category', value: 'bi', focused: true }] },
        ]);
        E.autocomplete('ticket');
        await w.sleep(40);
        const id = w.slash(u, g1, 'ticket', [
          {
            type: 1,
            name: 'open',
            options: [
              { type: 3, name: 'category', value: 'billing' },
              { type: 3, name: 'details', value: 'card 4111 1111 and my secret plan' },
            ],
          },
        ]);
        E.slash('ticket', 'ok');
        const reply = await waitFor(() => w.repliesTo(id)[0]);
        const [close, priority] = customIds(reply);
        if (i < 4) {
          w.component(u, g1, reply, close);
          E.component('ticket:close:*', 'ok');
        }
        if (i < 3) {
          await w.sleep(40);
          w.component(u, g1, reply, priority, 3, ['high']);
          E.component('ticket:priority', 'ok');
        }
        await w.sleep(60);
      }
      for (let i = 0; i < 3; i++) {
        w.slash(U[i], g2, 'ticket', [{ type: 1, name: 'list', options: [] }]);
        E.slash('ticket', 'ok');
        await w.sleep(40);
      }

      for (let i = 0; i < 4; i++) {
        const u = U[3 + i];
        const id = w.slash(u, g1, 'feedback');
        E.slash('feedback', 'ok');
        E.modalShown('feedback:form');
        await waitFor(() => w.responded(id));
        if (i < 3) {
          w.modalSubmit(u, g1, 'feedback:form', { text: 'Great bot, here is my secret plan' });
          E.modalSubmitted('feedback:form', 'ok');
        }
        await w.sleep(60);
      }

      for (let i = 0; i < 3; i++) {
        w.slash(U[i], g1, 'report');
        E.slash('report', 'ok');
        await w.sleep(40);
      }
      for (let i = 0; i < 2; i++) {
        w.slash(U[4 + i], g1, 'report', [{ type: 5, name: 'detailed', value: true }]);
        E.slash('report', 'timeout');
        await w.sleep(40);
      }
      for (let i = 0; i < 3; i++) {
        w.slash(U[i], g2, 'crash');
        E.slash('crash', 'error');
        await w.sleep(40);
      }

      for (let i = 0; i < 4; i++) {
        w.userMenu(U[i], g1, 'Profile', U[10]);
        E.userMenu('Profile', 'ok');
        await w.sleep(40);
      }
      const someMessage = w.botMessagesIn(g1.channels[0].id)[0];
      for (let i = 0; i < 2; i++) {
        w.messageMenu(U[i], g1, 'Quote', someMessage);
        E.messageMenu('Quote', 'ok');
        await w.sleep(40);
      }

      // A button from a feature the bot no longer handles: nobody answers it.
      for (let i = 0; i < 3; i++) {
        w.component(U[6], g1, someMessage, `legacy:vote:${991 + i}`);
        E.component('legacy:vote:*', 'no_response');
        await w.sleep(40);
      }

      // Opt-out through the /privacy command: neither the opt-out itself nor anything after it is recorded.
      const quitter = U[9];
      w.slash(quitter, g1, 'privacy', [{ type: 1, name: 'optout', options: [] }]);
      await w.sleep(300);
      for (let i = 0; i < 3; i++) {
        w.slash(quitter, g1, 'ping');
        await w.sleep(40);
      }

      for (let i = 0; i < 2; i++) {
        w.slash(U[13], null, 'ping');
        E.slash('ping', 'ok');
        await w.sleep(40);
      }

      // The collector goes down; the bot keeps working and Shardlens keeps the events until it is back.
      await w.pause('stop-collector');
      for (let i = 0; i < 5; i++) {
        w.slash(U[8], g2, 'ping');
        E.slash('ping', 'ok');
        await w.sleep(60);
      }
      await w.pause('start-collector');
      for (let i = 0; i < 2; i++) {
        w.slash(U[7], g2, 'ping');
        E.slash('ping', 'ok');
        await w.sleep(60);
      }

      w.joinGuild();
      E.join();
      await w.sleep(300);
      w.leaveGuild(g3);
      E.leave();
      // Unanswered interactions are reported after 10 seconds.
      await w.sleep(12_000);
      return E.done();
    },
  },

  // Two shards: server 1 is on shard 0, servers 2 to 4 on shard 1, DMs on shard 0. The bot is stopped with SIGINT to
  // the manager alone, which has to pass it on for the shards to flush.
  'ts-sharded': {
    appId: '1100000000000000004',
    registered: [
      ['ping', 1],
      ['server', 1],
      ['stats', 1],
      ['echo', 1],
      ['roulette', 1],
    ],
    async run(w) {
      const E = tally();
      const [g1, g2, g3] = w.guilds;
      const U = w.users;
      for (let i = 0; i < 9; i++) {
        w.slash(U[i], [g1, g2, g3][i % 3], 'ping');
        E.slash('ping', 'ok');
        await w.sleep(40);
      }
      for (let i = 0; i < 3; i++) {
        w.slash(U[i + 3], i ? g2 : g1, 'server');
        E.slash('server', 'ok');
        await w.sleep(40);
      }
      for (let i = 0; i < 4; i++) {
        w.slash(U[i + 5], i % 2 ? g1 : g3, 'echo', [{ type: 3, name: 'input', value: 'the secret plan, card 4111' }]);
        E.slash('echo', 'ok');
        await w.sleep(40);
      }
      for (let i = 0; i < 3; i++) {
        w.slash(U[i], i ? g2 : g1, 'roulette');
        E.slash('roulette', 'error');
        await w.sleep(40);
      }
      // Counts every shard's servers through the manager.
      for (let i = 0; i < 2; i++) {
        w.slash(U[9], i ? g1 : g2, 'stats');
        E.slash('stats', 'ok');
        await w.sleep(300);
      }
      for (let i = 0; i < 2; i++) {
        w.slash(U[12], null, 'ping');
        E.slash('ping', 'ok');
        await w.sleep(40);
      }
      w.joinGuild();
      E.join();
      await w.sleep(300);
      w.leaveGuild(g3);
      E.leave();
      await w.sleep(2_000);
      return E.done();
    },
  },

  sapphire: {
    appId: '1100000000000000003',
    async run(w) {
      const E = tally();
      const [g1, g2, g3] = w.guilds;
      const U = w.users;

      for (let i = 0; i < 8; i++) {
        w.slash(U[i % 5], g1, 'ping');
        E.slash('ping', 'ok');
        await w.sleep(40);
      }
      for (let i = 0; i < 9; i++) {
        w.say(U[3 + (i % 6)], g1, i % 3 === 2 ? '!pong' : '!ping');
        E.prefix('ping', 'ok');
        await w.sleep(60);
      }
      // Server 2's prefix is ">", stored in MongoDB before the bot started; `!ping` there is not a command.
      for (let i = 0; i < 3; i++) {
        w.say(U[2], g2, '>ping');
        E.prefix('ping', 'ok');
        await w.sleep(60);
      }
      w.say(U[2], g2, '!ping');

      for (let i = 0; i < 3; i++) {
        const id = w.slash(U[i], g1, 'poll', [{ type: 3, name: 'question', value: 'Pizza tonight? (secret plan)' }]);
        E.slash('poll', 'ok');
        const reply = await waitFor(() => w.repliesTo(id)[0]);
        const [yes, no] = customIds(reply);
        for (let v = 0; v < 2; v++) {
          w.component(U[5 + i * 2 + v], g1, reply, v === 0 ? yes : no);
          E.component(v === 0 ? 'poll:yes' : 'poll:no', 'ok');
          await w.sleep(60);
        }
      }

      for (let i = 0; i < 4; i++) {
        w.say(U[1], g3, i === 3 ? '!st' : '!stats');
        E.prefix('stats', 'error');
        await w.sleep(60);
      }
      for (let i = 0; i < 4; i++) {
        w.userMenu(U[i], g1, 'Stats', U[11]);
        E.userMenu('Stats', 'ok');
        await w.sleep(40);
      }

      w.joinGuild();
      E.join();
      await w.sleep(300);
      w.leaveGuild(g3);
      E.leave();
      await w.sleep(2_000);
      return E.done();
    },
  },
};

// The same scenarios for bots that keep their own data in MongoDB.
scenarios['mongo-prefix'] = { ...scenarios['js-prefix'], appId: '1100000000000000011' };
scenarios['mongo-sharded'] = { ...scenarios['ts-sharded'], appId: '1100000000000000012' };
scenarios['mongo-hybrid'] = { ...scenarios['ts-guide'], appId: '1100000000000000013' };
scenarios['mongo-modular'] = { ...scenarios.sapphire, appId: '1100000000000000014' };
