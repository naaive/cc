/**
 * Build the tool list.
 *
 * Assembles every built-in tool permitted by the host's allow/deny config,
 * shares the per-session `FileStateCache` / `PersistentShell` /
 * `BackgroundJobRegistry` / `ResultStore` / `DeferredToolRegistry` across
 * tools that need coordinated state, and delegates sub-agent dispatch to
 * a caller-supplied factory (so we can recurse without circular imports).
 */

import type { StructuredTool } from '@langchain/core/tools'
import {
  ALL_TOOL_NAMES,
  BackgroundJobRegistry,
  createAgentTool,
  createAskUserQuestionTool,
  createBashTools,
  createConfigTool,
  createCronTools,
  createDiscoverSlashCommandsTool,
  createEditTool,
  createExitPlanModeTool,
  createFileStateGuard,
  createGlobTool,
  createGrepTool,
  createMonitorTool,
  createNotebookEditTool,
  createPowerShellTool,
  createReadTool,
  createSlashCommandTool,
  createTodoWriteTool,
  createToolSearchTool,
  createWebFetchTool,
  createWebSearchTool,
  createWriteTool,
  CronScheduler,
  DeferredToolRegistry,
  MonitorRegistry,
  PersistentPowerShell,
  PersistentShell,
  resolveRoots,
  TOOL_NAMES,
  type AskUserQuestionResponder,
  type ConfigSettingSpec,
  type CronStore,
  type FileStateCache,
  type ResultStore,
  type SubAgent,
  type SubAgentFactory,
  type ToolName,
  type WebSearchImpl,
} from '../tools/index.js'
import {
  createDiscoverSkillsTool,
  createSkillTool,
  type SkillActivator,
  type SkillMetadata,
} from '../skills/index.js'
import type { CustomCommand } from '../commands/index.js'
import type { Settings } from '../settings.js'
import { ConfigurationError } from '../errors.js'

export interface BuildToolsInput {
  cwd: string
  settings: Settings
  fileStateCache: FileStateCache
  shell: PersistentShell
  powershell: PersistentPowerShell | null
  jobRegistry: BackgroundJobRegistry
  monitorRegistry: MonitorRegistry | null
  resultStore: ResultStore | null
  deferredRegistry: DeferredToolRegistry | null
  skillActivator: SkillActivator | null
  skills: SkillMetadata[]
  commands: CustomCommand[]
  configSettings: readonly ConfigSettingSpec[]
  cronStore: CronStore | null
  cronScheduler: CronScheduler | null
  subagents: SubAgent[]
  subAgentFactory: SubAgentFactory
  webSearch?: WebSearchImpl
  askUserQuestion?: AskUserQuestionResponder
  additionalDirectories: string[]
  disable: ReadonlyArray<ToolName>
  userTools: StructuredTool[]
}

export interface BuildToolsResult {
  ccTools: StructuredTool[]
  /** All tool names — built-in + user — that the agent will see. */
  allToolNames: string[]
}

export function buildTools(input: BuildToolsInput): BuildToolsResult {
  const isEnabled = makeEnabledChecker(input)
  const ccTools: StructuredTool[] = []
  const fileStateGuard = createFileStateGuard({
    cache: input.fileStateCache,
    resultStore: input.resultStore,
    roots: resolveRoots(input.cwd, input.additionalDirectories),
  })

  if (isEnabled(TOOL_NAMES.Bash)) {
    const bundle = createBashTools({
      cwd: input.cwd,
      denyPatterns: input.settings.bashDeny,
      allowPatterns: input.settings.bashAllow,
      shellInstance: input.shell,
      jobRegistry: input.jobRegistry,
    })
    ccTools.push(bundle.bash as StructuredTool)
    if (isEnabled(TOOL_NAMES.BashOutput)) ccTools.push(bundle.bashOutput as StructuredTool)
    if (isEnabled(TOOL_NAMES.KillShell)) ccTools.push(bundle.killShell as StructuredTool)
  }

  if (isEnabled(TOOL_NAMES.Read))
    ccTools.push(
      createReadTool({
        fileStateGuard,
        onFileRead: input.skillActivator
          ? abs => input.skillActivator!.notice(abs)
          : undefined,
      }),
    )
  if (isEnabled(TOOL_NAMES.Write))
    ccTools.push(createWriteTool({ fileStateGuard }))
  if (isEnabled(TOOL_NAMES.Edit))
    ccTools.push(createEditTool({ fileStateGuard }))
  if (isEnabled(TOOL_NAMES.NotebookEdit))
    ccTools.push(createNotebookEditTool({ fileStateGuard }))
  if (isEnabled(TOOL_NAMES.Glob)) ccTools.push(createGlobTool({ cwd: input.cwd }))
  if (isEnabled(TOOL_NAMES.Grep)) ccTools.push(createGrepTool({ cwd: input.cwd }))
  if (isEnabled(TOOL_NAMES.TodoWrite)) ccTools.push(createTodoWriteTool())

  if (isEnabled(TOOL_NAMES.WebFetch))
    ccTools.push(
      createWebFetchTool({ allowHosts: input.settings.webFetchAllowHosts }),
    )
  if (isEnabled(TOOL_NAMES.WebSearch) && input.webSearch)
    ccTools.push(createWebSearchTool(input.webSearch))
  if (isEnabled(TOOL_NAMES.AskUserQuestion))
    ccTools.push(createAskUserQuestionTool(input.askUserQuestion))
  if (isEnabled(TOOL_NAMES.ExitPlanMode))
    ccTools.push(createExitPlanModeTool())

  if (
    input.subagents.length > 0 &&
    isEnabled(TOOL_NAMES.Agent)
  ) {
    ccTools.push(
      createAgentTool({
        subagents: input.subagents,
        factory: input.subAgentFactory,
      }),
    )
  }

  if (input.deferredRegistry && input.deferredRegistry.size() > 0) {
    ccTools.push(createToolSearchTool(input.deferredRegistry) as StructuredTool)
  }

  if (input.skills.length > 0) {
    ccTools.push(
      createDiscoverSkillsTool({ getSkills: () => input.skills }) as StructuredTool,
    )
    ccTools.push(
      createSkillTool({ getSkills: () => input.skills }) as StructuredTool,
    )
  }

  // PowerShell — opt-in (host injects a shell instance for Windows runs).
  if (input.powershell && isEnabled(TOOL_NAMES.PowerShell)) {
    ccTools.push(
      createPowerShellTool({
        cwd: input.cwd,
        denyPatterns: input.settings.bashDeny,
        allowPatterns: input.settings.bashAllow,
        shellInstance: input.powershell,
      }) as StructuredTool,
    )
  }

  // Monitor — long-running bg jobs with completion notifications.
  if (input.monitorRegistry && isEnabled(TOOL_NAMES.Monitor)) {
    ccTools.push(
      createMonitorTool({
        registry: input.monitorRegistry,
        cwd: input.cwd,
      }) as StructuredTool,
    )
  }

  // Cron — scheduled future invocations.
  if (input.cronStore && input.cronScheduler) {
    const cron = createCronTools({
      store: input.cronStore,
      scheduler: input.cronScheduler,
    })
    if (isEnabled(TOOL_NAMES.CronCreate)) ccTools.push(cron.cronCreate as StructuredTool)
    if (isEnabled(TOOL_NAMES.CronList)) ccTools.push(cron.cronList as StructuredTool)
    if (isEnabled(TOOL_NAMES.CronDelete)) ccTools.push(cron.cronDelete as StructuredTool)
  }

  // Config — whitelisted settings.json read/write.
  if (isEnabled(TOOL_NAMES.Config)) {
    ccTools.push(
      createConfigTool({
        cwd: input.cwd,
        supportedSettings: input.configSettings,
      }) as StructuredTool,
    )
  }

  // SlashCommand + DiscoverSlashCommands — only when commands are loaded.
  if (input.commands.length > 0) {
    if (isEnabled(TOOL_NAMES.SlashCommand)) {
      ccTools.push(
        createSlashCommandTool({
          cwd: input.cwd,
          getCommands: () => input.commands,
          runBash: async (cmd: string) => {
            const r = await input.shell.run(cmd)
            return r.stdout
          },
        }) as StructuredTool,
      )
    }
    if (isEnabled(TOOL_NAMES.DiscoverSlashCommands)) {
      ccTools.push(
        createDiscoverSlashCommandsTool({
          getCommands: () => input.commands,
        }) as StructuredTool,
      )
    }
  }

  enforceNoCollisions(ccTools, input.userTools)

  return {
    ccTools,
    allToolNames: [
      ...ccTools.map(t => t.name),
      ...input.userTools.map(t => t.name),
    ],
  }
}

function makeEnabledChecker(input: BuildToolsInput): (name: ToolName) => boolean {
  const disabled = new Set<ToolName>(input.disable)
  const allowed = input.settings.allowedTools
    ? new Set(input.settings.allowedTools)
    : null
  const denied = new Set(input.settings.deniedTools ?? [])
  return name =>
    !disabled.has(name) && !denied.has(name) && (!allowed || allowed.has(name))
}

function enforceNoCollisions(
  ccTools: StructuredTool[],
  userTools: StructuredTool[],
): void {
  const userNames = new Set(userTools.map(t => t.name))
  const collisions = ccTools.map(t => t.name).filter(n => userNames.has(n))
  if (collisions.length > 0) {
    throw new ConfigurationError(
      `User tools collide with built-ins: ${collisions.join(', ')}`,
      'TOOL_NAME_COLLISION',
    )
  }
}

export { ALL_TOOL_NAMES }
