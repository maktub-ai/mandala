export type BlueprintRoute = {projectId:string|null; lane:string|null; assigneeAgentId:string|null};
export type RouteProject = {id:string; name:string; modules:string[]; observers:{id:string;name:string}[]};
export type RouteReview = {
  id:string; goal:string; projects:RouteProject[]; suggestion:BlueprintRoute;
  status:'pending'|'confirmed'|'dismissed'; selection:BlueprintRoute|null; matched:boolean|null; taskId:string|null;
};
