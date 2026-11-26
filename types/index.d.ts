// The identity of this process: held by the host under the plugin's own state value (survives a hot reload, absent in
// another process) and mirrored into the environment for the relay's header and the mod's own record.
export type Identity = { instance: string; owner: string }
// The tracked work of the session the mod reports, held by the host under a second state value as it changes, so a
// hot reload of the module restores it before the registration's answer is reconciled: each agent's open set, the
// session's crons, the subagents this run released and those the router last named released, under the session id
// they belong to.
export type SavedTask = { id: string; kind: 'command' | 'subagent'; deadline?: number }
export type AgentFactSet = { agent_type?: string; description?: string; name?: string }
export type SavedAgent = {
  id: string
  parent?: string
  state: 'busy' | 'idle' | 'parked' | 'released'
  open: SavedTask[]
  lastPresence: number
}
export type SavedCron = { id: string; wakeAt: number; recurring: boolean; expression?: string; createdAt: number }
// The session's facts, the members that a session_facts report carries.
export type SessionFactSet = {
  branch?: string
  cwd?: string
  project?: string
  repository?: string
  repository_root?: string
  title?: string
}
export type SavedModel = { id: string; agents: SavedAgent[]; crons: SavedCron[]; released: string[];
  routerReleased: string[] }
// `facts` is the last set queued for the agent, and `factsOwed` stands while the router has not answered that set
// for good. An agent with neither has no entry.
export type SavedAgentFacts = { id: string; facts?: AgentFactSet; factsOwed?: true }
// The sets the mod last queued, under a state value of their own, so that a read behind a reload sends a change
// alone and a clear the router has not confirmed goes out again. `factsOwed` stands for an empty set too.
export type SavedFacts = { id: string; agents: SavedAgentFacts[]; facts?: SessionFactSet; factsOwed?: true }
declare module 'claude-code' {
  interface PluginState { 'phoebis-companion': { facts: SavedFacts; identity: Identity; model: SavedModel } }
}
