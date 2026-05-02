export type ConfigurationErrorCode =
  | 'TOOL_NAME_COLLISION'
  | 'INVALID_PERMISSION'
  | 'INVALID_AGENT_NAME'
  | 'INVALID_SUBAGENT'
  | 'MODEL_REQUIRED'

export class ConfigurationError extends Error {
  readonly code: ConfigurationErrorCode

  constructor(message: string, code: ConfigurationErrorCode) {
    super(message)
    this.name = 'ConfigurationError'
    this.code = code
  }
}

export class HookFailureError extends Error {
  readonly event: string
  readonly hookCommand: string

  constructor(event: string, hookCommand: string, cause: string) {
    super(`Hook failed (${event}, ${hookCommand}): ${cause}`)
    this.name = 'HookFailureError'
    this.event = event
    this.hookCommand = hookCommand
  }
}
