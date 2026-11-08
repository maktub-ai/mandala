import { expect, test } from 'vitest';
import { businessCliInstructions } from '../server/business-cli-runtime';

const runtime={launcher:'/tmp/mandala',contextFile:'/tmp/context.json',command:'/tmp/mandala',dispose(){}};

test('available memory tells the Agent when to search and how to deepen excerpts into evidence', () => {
 const instructions=businessCliInstructions(runtime,{project:false,assets:false,memory:true});
 expect(instructions).toContain('historical decisions or preferences');
 expect(instructions).toContain('missing parameters or conflicting recollections');
 expect(instructions).toContain('Search returns excerpts, not complete records');
 expect(instructions).toContain('dependency recordIds');
 expect(instructions).toContain('never invent missing evidence');
 expect(instructions).toContain('respect disabled reading');
});

test('a runtime without memory does not advertise memory commands or retrieval instructions', () => {
 const instructions=businessCliInstructions(runtime,{project:false,assets:false,memory:false});
 expect(instructions).not.toContain('memory search');
 expect(instructions).not.toContain('memory read');
 expect(instructions).not.toContain('Memory retrieval policy');
});
