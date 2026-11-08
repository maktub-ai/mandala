export type DesktopCliStatus = {
 supported:boolean; installed:boolean; runtimeReady:boolean; launcherPath:string; command:string;
 inPath:boolean; shadowed:boolean; existingCommand:string|null; conflict:boolean; updateAvailable:boolean;
 backupPath?:string;
};
export type DesktopCli = {status:()=>Promise<DesktopCliStatus>;install:()=>Promise<DesktopCliStatus>};
