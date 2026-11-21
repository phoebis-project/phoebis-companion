// The identity of this process: held by the host under the plugin's own state value (survives a hot reload, absent in
// another process) and mirrored into the environment for the relay's header and the mod's own record.
export type Identity = { instance: string; owner: string }
// The tracked work of the session the mod reports, held by the host under a second state value as it changes, so a
// hot reload of the module restores it before the registration's answer is reconciled: each agent's open set, the
// session's crons, the subagents this run released and those the router last named released, under the session id
// they belong to.
export type SavedTask = { id: string; kind: 'command' | 'subagent'; deadline?: number }
export type AgentFactSet = { agent_type?: string; description?: string; name?: string }
// `facts` is the last set queued for the agent and `factsOwed` stands while the router has not answered that set for
// good, kept for the same reasons as the session's set below.
export type SavedAgent = {
  id: string
  parent?: string
  state: 'busy' | 'idle' | 'parked' | 'released'
  open: SavedTask[]
  lastPresence: number
  facts?: AgentFactSet
  factsOwed?: true
}
export type SavedCron = { id: string; wakeAt: number; recurring: boolean; expression?: string; createdAt: number }
// The facts the mod last queued for the session, kept so that a read behind a reload sends a change alone, and so
// that an option turned off clears what it sent.
export type SessionFactSet = {
  branch?: string
  cwd?: string
  project?: string
  repository?: string
  repository_root?: string
  title?: string
}
// `factsOwed` stands while the router has not answered the last set queued for good, an empty set among them.
// `factsLeft` names the released subagents whose facts the router can still hold, since it restarts a released
// record with its facts when the agent runs again, so their next run states its set whole.
export type SavedModel = { id: string; agents: SavedAgent[]; crons: SavedCron[]; released: string[];
  routerReleased: string[]; facts?: SessionFactSet; factsOwed?: true; factsLeft?: string[] }
declare module 'claude-code' {
  interface PluginState { 'phoebis-companion': { identity: Identity; model: SavedModel } }
}
