import type { BotModule } from '../framework/module.js';
import { coreModule } from './core/core.module.js';
import { pollsModule } from './polls/polls.module.js';
import { settingsModule } from './settings/settings.module.js';
import { statsModule } from './stats/stats.module.js';

/** Enabled features, in load order. */
export const modules: readonly BotModule[] = [coreModule, settingsModule, pollsModule, statsModule];
