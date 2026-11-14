// TypeDoc names modules after their path ("discordjs/src"); show the npm package names instead.
import { Converter } from 'typedoc';

/** @param {import('typedoc').Application} app */
export function load(app) {
  app.converter.on(Converter.EVENT_RESOLVE_BEGIN, (context) => {
    for (const mod of context.project.children ?? []) {
      const match = /^([\w-]+)\/src$/.exec(mod.name);
      if (match) mod.name = `@shardlens/${match[1]}`;
    }
  });
}
