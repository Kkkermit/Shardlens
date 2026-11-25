// Type-checks the TypeScript samples in every prompt (prompts/*.md) against the real packages, so the prompts people
// paste into their agent can't drift from the API.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = `${root}node_modules/.cache/prompt-check/`;

const prompts = readdirSync(`${root}prompts`).filter((name) => name.endsWith('.md'));
const samples = prompts.flatMap((name) => {
  const found = [...readFileSync(`${root}prompts/${name}`, 'utf8').matchAll(/```ts\r?\n([\s\S]*?)```/g)];
  return found.map((match, i) => ({ name: `${name.replace(/\.md$/, '')}-${i + 1}`, code: match[1] }));
});
if (samples.length === 0) throw new Error('No TypeScript samples found in prompts/');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// What the samples assume the bot already has.
const globals = `${out}globals.d.ts`;
writeFileSync(
  globals,
  `import type { Shardlens } from '@shardlens/discordjs';
import type { ChatInputCommandInteraction, Client, Message } from 'discord.js';
declare global {
  const client: Client;
  const lens: Shardlens;
  const interaction: ChatInputCommandInteraction;
  const commands: Map<string, { execute(interaction: ChatInputCommandInteraction): Promise<void> }>;
  const prefixCommands: Map<string, { name: string; execute(message: Message, args: string[]): Promise<void> }>;
}
`,
);
const files = samples.map(({ name, code }) => {
  const file = `${out}${name}.ts`;
  writeFileSync(file, `${code}\nexport {};\n`);
  return file;
});

const config = ts.getParsedCommandLineOfConfigFile(
  `${root}snippets/tsconfig.json`,
  { noEmit: true },
  {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  },
);
const program = ts.createProgram([...files, globals], config.options);
const diagnostics = ts.getPreEmitDiagnostics(program);

if (diagnostics.length > 0) {
  console.error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => root,
      getNewLine: () => '\n',
    }),
  );
  console.error(`prompts/: ${diagnostics.length} problem(s) in their TypeScript samples`);
  process.exit(1);
}
console.log(`prompts/: ${samples.length} TypeScript samples in ${prompts.length} prompts type-check`);
