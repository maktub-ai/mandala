import { skillIdentity, skillResources } from "./skills";
import type { Agent, Config, Project, Skill } from "./types";

export function linkedCapabilities(config: Config, owner: Agent | Project) {
  const definitions = <T extends { id: string }>(ids: string[] | undefined, library: T[] | undefined, disabled: string[] = []) =>
    (ids ?? []).flatMap(id => {
      const item = library?.find(entry => entry.id === id);
      if (!item) throw new Error("Capability reference not found");
      const { id: _id, ...definition } = item;
      return disabled.includes(id) ? [] : [definition];
    });
  const skills=(owner.skillIds??[]).flatMap(id=>{
    const definition=config.skillLibrary?.find(skill=>skill.id===id);
    if(!definition)throw new Error("Capability reference not found");
    if(owner.disabledSkillIds?.includes(id)||definition.unavailable)return [];
    const {name,path,content,[skillResources]:resources}=definition;
    const skill:Skill={name,path,...(content!==undefined?{content}:{}),...(resources?{[skillResources]:resources}:{})};
    Object.defineProperty(skill,skillIdentity,{value:{id,versionRef:definition.versionRef}});
    return [skill];
  });
  return { mcp: [...owner.mcp, ...definitions(owner.connectionIds, config.connections, owner.disabledConnectionIds)],
    skills: [...owner.skills, ...skills] };
}
