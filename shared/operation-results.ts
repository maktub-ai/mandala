export type OperationOutcome={kind:'task'|'automation'|'content'|'discovery'|'agent';name:string;facts:Record<string,string>;path?:string};
export type OperationResult=OperationOutcome&{id:string;command:string;state:'succeeded'|'failed'|'unknown';sourceEventId:number|null;invocationId:string;createdAt:string;errorCode?:string};
