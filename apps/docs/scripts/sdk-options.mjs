// Extracts every ShardlensOptions property (name, type, required, JSDoc) from the adapter's source with the TypeScript
// compiler API, so the configuration reference is generated from the code instead of copied by hand.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../../../packages/discordjs/src/options.ts');
const out = resolve(here, '../src/generated/sdk-options.json');

const program = ts.createProgram([source], { strict: true, exactOptionalPropertyTypes: true, skipLibCheck: true });
const checker = program.getTypeChecker();
const file = program.getSourceFile(source);
if (!file) throw new Error(`Cannot read ${source}`);

const options = [];
ts.forEachChild(file, (node) => {
  if (!ts.isInterfaceDeclaration(node) || node.name.text !== 'ShardlensOptions') return;
  for (const member of node.members) {
    if (!ts.isPropertySignature(member) || !member.type) continue;
    const symbol = checker.getSymbolAtLocation(member.name);
    const name = member.name.getText(file);
    const type = member.type
      .getText(file)
      .replace(/\s*\|\s*undefined$/, '')
      .replace(/\s+/g, ' ');
    const description = ts.displayPartsToString(symbol?.getDocumentationComment(checker) ?? []).replace(/\s+/g, ' ');
    if (!description) throw new Error(`ShardlensOptions.${name} has no JSDoc; document it before building the docs`);
    options.push({ name, type, required: !member.questionToken, description });
  }
});
if (options.length === 0) throw new Error('ShardlensOptions not found');

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(options, null, 2)}\n`);
console.log(`sdk-options.json: ${options.length} options`);
