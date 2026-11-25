import {expect,it} from 'vitest';
import {projectParticipantIds} from '../src/project-participants';

it('includes task participants and local conversation agents once, keeping other projects’ executions separate',()=>{
 const tasks=[{
  assigneeAgentId:'lead',participantAgentIds:['collaborator','lead'],
  executions:[
   {agentId:'local',projectId:'old',attributedProjectId:'app'},
   {agentId:'remote',projectId:'service'},
   {agentId:'rerouted',projectId:'app',attributedProjectId:'service'},
   {agentId:'replaced',projectId:'app',supersededByExecutionId:'current'}
  ]
 }];
 const chats=[{agentId:'local'},{agentId:'session-only'},{agentId:null}];
 expect([...projectParticipantIds('app',tasks,chats)].sort()).toEqual(['collaborator','lead','local','session-only']);
});
