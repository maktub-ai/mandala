import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Config, SkillDefinition, SkillSource } from '../shared/types';
import { DomainError } from '../shared/workspace-contracts';
import { readConfig, validateConfig, writeConfig } from './config';
import { createSkillCatalog } from './skill-catalog';
import { validateManagedSkillContent } from '../shared/skills';
import { randomUUID } from 'node:crypto';
import type { Store } from './store';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const managed = (skill: SkillDefinition) => typeof skill.content === 'string' && skill.path === '';
const summary = (skill: SkillDefinition) => ({ id: skill.id, name: skill.name });
const detail = (skill: SkillDefinition) => ({ ...skill, scope: 'system' as const });

// Invocation tools operate only on managed catalog content, never on external paths.
export function createSkillService(home: string, store: Store) {
  store.database.exec(`CREATE TABLE IF NOT EXISTS skill_registration_receipts (
    agent_id TEXT NOT NULL, command_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
    skill_id TEXT NOT NULL, complete INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(agent_id, command_key)
  )`);
  if(!store.database.prepare('PRAGMA table_info(skill_registration_receipts)').all().some(row=>row.name==='journal_guarded'))store.database.exec('ALTER TABLE skill_registration_receipts ADD COLUMN journal_guarded INTEGER NOT NULL DEFAULT 0');
  const catalog=createSkillCatalog(home,store);
  store.database.exec(`CREATE TABLE IF NOT EXISTS skill_update_receipts(agent_id TEXT NOT NULL,command_key TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT,PRIMARY KEY(agent_id,command_key)); CREATE TABLE IF NOT EXISTS skill_suggestions(id TEXT PRIMARY KEY,skill_id TEXT NOT NULL,agent_id TEXT NOT NULL,command_key TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(agent_id,command_key))`);
  const pending = new Map<string, Promise<unknown>>();
  return async (agentId: string, name: string, args: Record<string, unknown>, commandKey: string, assertActive: () => void,source?:SkillSource,context?:{projectId?:string}): Promise<unknown> => {
    const fields: Record<string, string[]> = { skill_find: ['query'], skill_read: ['skillId'], skill_register: ['name', 'content'], skill_update:['skillId','content','expectedVersionId'], skill_versions:['skillId'], skill_suggestions:['skillId'], skill_accept:['skillId','suggestionId'], skill_reject:['skillId','suggestionId'] };
    const allowed = fields[name];
    if (!allowed) throw new DomainError('forbidden', 403, 'Unknown skill command');
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !allowed.includes(key)))
      throw new DomainError('invalid_tool_arguments', 422, 'Unknown skill argument');
    const authorize = (config: Config) => {
      assertActive();
      if (!config.agents.some(agent => agent.id === agentId)) throw new DomainError('forbidden', 403, 'Agent no longer exists');
    };
    const proposalAllowed=(skill:SkillDefinition,proposal:{agentId:string;source?:SkillSource},config:Config)=>catalog.assertEvidence({...skill,creatorAgentId:proposal.agentId},proposal.source,agentId,config,context?.projectId);
    const guardSource=(skill:SkillDefinition,proposal:{agentId:string;source?:SkillSource})=>{assertActive();proposalAllowed(skill,proposal,JSON.parse(readFileSync(join(home,'config.json'),'utf8')) as Config);};
    if(['skill_update','skill_accept','skill_reject','skill_versions','skill_suggestions'].includes(name)) {
      const snapshot=await readConfig(home);authorize(snapshot.config);
      const skill=snapshot.config.skillLibrary?.find(item=>item.id===args.skillId);
      if(!skill)throw new DomainError('not_found',404,'Skill not found');
      catalog.read(skill,agentId,snapshot.config,context?.projectId);
      if(name==='skill_versions')return {items:catalog.versions(skill,agentId,snapshot.config,context?.projectId)};
      if(name==='skill_suggestions')return {items:store.database.prepare('SELECT data FROM skill_suggestions WHERE skill_id=?').all(skill.id).map(row=>JSON.parse(row.data as string)).filter(proposal=>{try{proposalAllowed(skill,proposal,snapshot.config);return true;}catch{return false;}})};
      if(!commandKey?.trim()||commandKey.length>200)throw new DomainError('invalid_tool_arguments',422,'Supply a command key');
      if(name==='skill_update') {
        const proposal={agentId,source:source??skill.source};proposalAllowed(skill,proposal,snapshot.config);
        if(validateManagedSkillContent(skill.name,args.content))throw new DomainError('invalid_tool_arguments',422,'Invalid Skill content');
        const fingerprint=digest(args);
        const receipt=store.database.prepare('SELECT * FROM skill_update_receipts WHERE agent_id=? AND command_key=?').get(agentId,commandKey);
        if(receipt){if(receipt.fingerprint!==fingerprint)throw new DomainError('command_conflict',409,'Command key already used');if(receipt.result){const result=JSON.parse(receipt.result as string);if(result.skill)catalog.read(result.skill,agentId,snapshot.config,context?.projectId);return result;}if(skill.content===args.content){const result={skill:detail(skill)};store.database.prepare('UPDATE skill_update_receipts SET result=? WHERE agent_id=? AND command_key=?').run(JSON.stringify(result),agentId,commandKey);return result;}}
        const prior=store.database.prepare('SELECT data FROM skill_suggestions WHERE agent_id=? AND command_key=?').get(agentId,commandKey);
        if(prior){const suggestion=JSON.parse(prior.data as string);if(suggestion.fingerprint!==fingerprint)throw new DomainError('command_conflict',409,'Command key already used');proposalAllowed(skill,suggestion,snapshot.config);return {suggestion};}
        if((args.expectedVersionId??null)!==(skill.versionRef?.versionId??null))throw new DomainError('stale_revision',409,'Skill version changed');
        const shared=snapshot.config.agents.some(agent=>agent.id!==agentId&&agent.skillIds?.includes(skill.id))||snapshot.config.projects.some(project=>project.skillIds?.includes(skill.id));
        if(skill.creatorAgentId!==agentId||skill.humanMaintained||shared||skill.path!==''){
          const suggestion={id:randomUUID(),skillId:skill.id,agentId,content:args.content,expectedVersionId:args.expectedVersionId??null,fingerprint,status:'pending',createdAt:new Date().toISOString(),source:source??skill.source};
          authorize(snapshot.config);store.database.prepare('INSERT INTO skill_suggestions VALUES(?,?,?,?,?)').run(suggestion.id,skill.id,agentId,commandKey,JSON.stringify(suggestion));return {suggestion};
        }
        if(args.content===skill.content)return {skill:detail(skill),unchanged:true};
        const next={...snapshot.config,skillLibrary:snapshot.config.skillLibrary!.map(item=>item.id===skill.id?{...item,content:args.content as string,...(source?{source}:{})}:item)};
        store.database.prepare('INSERT OR IGNORE INTO skill_update_receipts VALUES(?,?,?,NULL)').run(agentId,commandKey,fingerprint);
        await writeConfig(home,next,snapshot.revision,()=>guardSource(skill,proposal));
        const result={skill:detail((await readConfig(home)).config.skillLibrary!.find(item=>item.id===skill.id)!)};
        store.database.prepare('UPDATE skill_update_receipts SET result=? WHERE agent_id=? AND command_key=?').run(JSON.stringify(result),agentId,commandKey);return result;
      }
      const row=store.database.prepare('SELECT data FROM skill_suggestions WHERE id=? AND skill_id=?').get(String(args.suggestionId),skill.id);
      if(!row)throw new DomainError('not_found',404,'Suggestion not found');
      const suggestion=JSON.parse(row.data as string);
      proposalAllowed(skill,suggestion,snapshot.config);
      if(skill.creatorAgentId!==agentId)throw new DomainError('forbidden',403,'Only the Skill maintainer can decide suggestions');
      if(suggestion.status!=='pending')return {suggestion,skill:detail(skill)};
      if(name==='skill_accept'){
        if(skill.versionRef?.versionId!==suggestion.expectedVersionId)throw new DomainError('stale_revision',409,'Suggestion baseline changed');
        if(skill.path!=='')throw new DomainError('external_skill',409,'Edit external packages at their source');
        proposalAllowed(skill,suggestion,snapshot.config);
        const next={...snapshot.config,skillLibrary:snapshot.config.skillLibrary!.map(item=>item.id===skill.id?{...item,content:suggestion.content,humanMaintained:true,...(suggestion.source?{source:suggestion.source}:{})}:item)};
        await writeConfig(home,next,snapshot.revision,()=>guardSource(skill,suggestion));
      }
      assertActive();suggestion.status=name==='skill_accept'?'accepted':'rejected';store.database.prepare('UPDATE skill_suggestions SET data=? WHERE id=?').run(JSON.stringify(suggestion),suggestion.id);
      return {suggestion,skill:detail((await readConfig(home)).config.skillLibrary!.find(item=>item.id===skill.id)!)};
    }
    if (name !== 'skill_register') {
      if (name === 'skill_find' && args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 2000) ||
          name === 'skill_read' && (typeof args.skillId !== 'string' || !args.skillId || args.skillId.length > 100))
        throw new DomainError('invalid_tool_arguments', 422, 'Invalid skill search or ID');
      const { config } = await readConfig(home); authorize(config);
      const skills = (config.skillLibrary ?? []).flatMap(skill=>{try{const resolved=catalog.read(skill,agentId,config,context?.projectId);return managed(resolved)?[resolved]:[];}catch{return [];}});
      if (name === 'skill_read') {
        const raw=config.skillLibrary?.find(item=>item.id===args.skillId);
        const skill=raw?catalog.read(raw,agentId,config,context?.projectId):undefined;
        if (!skill||!managed(skill)) throw new DomainError('not_found', 404, 'Managed skill not found');
        return detail(skill);
      }
      const query = String(args.query ?? '').trim().toLowerCase();
      const matches = skills.filter(skill => !query || `${skill.name}\n${skill.content}`.toLowerCase().includes(query));
      return { items: matches.slice(0, 100).map(summary), truncated: matches.length > 100, scope: 'system' };
    }
    if (typeof commandKey !== 'string' || !commandKey.trim() || commandKey.length > 200 ||
        typeof args.name !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(args.name) ||
        typeof args.content !== 'string' || !args.content.trim() || Buffer.byteLength(args.content, 'utf8') > 100 * 1024)
      throw new DomainError('invalid_tool_arguments', 422, 'Supply a skill name and nonempty SKILL.md content up to 100 KiB');
    const input = { name: args.name, content: args.content }, key = JSON.stringify([agentId, commandKey]);
    const fingerprint = digest(input), skillId = 'skill-' + digest([agentId, commandKey]).slice(0, 32);
    const operation = (pending.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const snapshot = await readConfig(home); authorize(snapshot.config);
      const receipt = store.database.prepare('SELECT * FROM skill_registration_receipts WHERE agent_id=? AND command_key=?').get(agentId, commandKey);
      if (receipt && receipt.fingerprint !== fingerprint) throw new DomainError('command_conflict', 409, 'Command key already used with different input');
      let skill = snapshot.config.skillLibrary?.find(item => item.id === skillId);
      if (receipt?.complete === 1 && !skill) throw new DomainError('not_found', 404, 'Previously registered skill was removed');
      const published=store.database.prepare("SELECT version_id FROM skill_publication_journal WHERE skill_id=? AND state='published' LIMIT 1").get(skillId);
      // Journal-guarded attempts are retryable only when no canonical publication ever committed.
      if (receipt?.complete === 0 && !skill && (receipt.journal_guarded!==1||published)) throw new DomainError('command_unconfirmed', 409, 'Previous registration was interrupted; inspect the library before issuing another command');
      if(receipt?.complete===-1&&!skill&&published)throw new DomainError('not_found',404,'Previously registered skill was removed');
      if (skill && (!managed(skill) || !receipt || receipt.complete !== 1 && (skill.name !== input.name || skill.content !== input.content)))
        throw new DomainError('command_conflict', 409, 'Registered skill changed; inspect the catalog');
      if (!skill) {
        if (snapshot.config.skillLibrary?.some(item => item.name === input.name))
          throw new DomainError('skill_exists', 409, 'Skill name already exists; inspect the library instead of registering it again');
        skill = { id: skillId, ...input, path: '',creatorAgentId:agentId,source:source??{method:'agent',verification:'draft'} };
        const next = { ...snapshot.config, agents:snapshot.config.agents.map(agent=>agent.id===agentId?{...agent,skillIds:[...new Set([...agent.skillIds??[],skillId])],disabledSkillIds:agent.disabledSkillIds?.filter(id=>id!==skillId)}:agent), skillLibrary: [...snapshot.config.skillLibrary ?? [], skill] };
        try { validateConfig(next); }
        catch (error) { throw new DomainError('invalid_tool_arguments', 422, error instanceof Error ? error.message : 'Invalid skill content'); }
        if (!receipt) store.database.prepare('INSERT INTO skill_registration_receipts(agent_id,command_key,fingerprint,skill_id,complete,journal_guarded) VALUES(?,?,?,?,0,1)').run(agentId, commandKey, fingerprint, skillId);
        else store.database.prepare('UPDATE skill_registration_receipts SET complete=0 WHERE agent_id=? AND command_key=?').run(agentId, commandKey);
        try {
          await writeConfig(home, next, snapshot.revision, ()=>guardSource(skill!,{agentId,source:skill!.source}));
        } catch (error) {
          const persisted=(await readConfig(home)).config.skillLibrary?.some(item=>item.id===skillId);
          const published=store.database.prepare("SELECT version_id FROM skill_publication_journal WHERE skill_id=? AND state='published' LIMIT 1").get(skillId);
          if(!persisted&&!published)store.database.prepare('UPDATE skill_registration_receipts SET complete=-1 WHERE agent_id=? AND command_key=?').run(agentId,commandKey);
          if (error instanceof Error && error.message === 'configuration changed' || error instanceof DomainError && error.status === 403) {
            // Retry state was set above only after config and publication-journal checks.
            if (!(error instanceof DomainError)) throw new DomainError('stale_revision', 409, 'Configuration changed; retry with the same command key');
          }
          throw error;
        }
      }
      store.database.prepare('UPDATE skill_registration_receipts SET complete=1 WHERE agent_id=? AND command_key=?').run(agentId, commandKey);
      const saved = await readConfig(home); authorize(saved.config);
      const stored = saved.config.skillLibrary?.find(item => item.id === skillId && managed(item));
      if (!stored) throw new DomainError('not_found', 404, 'Registered skill is no longer available');
      catalog.read(stored,agentId,saved.config,context?.projectId);
      return { skill: detail(stored), revision: saved.revision, assigned: true };
    });
    pending.set(key, operation);
    try { return await operation; }
    finally { if (pending.get(key) === operation) pending.delete(key); }
  };
}
