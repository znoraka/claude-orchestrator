export interface Session {
  id: string;
  name: string;
  status: "running" | "stopped" | "starting";
  createdAt: number;
  lastActiveAt: number;
  directory: string;
  claudeSessionId?: string;
  dangerouslySkipPermissions?: boolean;
}
