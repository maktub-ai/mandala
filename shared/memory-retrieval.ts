export type MemoryRetrievalSettings={enabled:boolean;provider:'ollama'|'openai';baseUrl:string;model:string;hasApiKey:boolean};
export const defaultMemoryRetrievalSettings:MemoryRetrievalSettings={enabled:false,provider:'openai',baseUrl:'',model:'',hasApiKey:false};
