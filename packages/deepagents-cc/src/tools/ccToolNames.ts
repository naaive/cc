/**
 * cc-aligned tool names and descriptions.
 *
 * Tool *names* are part of the API contract — when we tell the model
 * "use the Edit tool", and the API exposes `Edit`, the prompts, the system
 * reminders, and the tool list all have to agree. Centralising them in
 * one file makes that easy to audit.
 *
 * Tool *descriptions* are taken verbatim from `packages/builtin-tools/`
 * where possible. We keep cc's exact wording because the model's
 * tool-selection behaviour is sensitive to phrasing — paraphrasing
 * "Performs exact string replacements in files." into "Edit a file"
 * subtly changes when the model reaches for Edit vs. Write.
 */

export const TOOL_NAMES = {
  Bash: 'Bash',
  BashOutput: 'BashOutput',
  KillShell: 'KillShell',
  Read: 'Read',
  Write: 'Write',
  Edit: 'Edit',
  Glob: 'Glob',
  Grep: 'Grep',
  WebFetch: 'WebFetch',
  WebSearch: 'WebSearch',
  TodoWrite: 'TodoWrite',
  Agent: 'Agent',
  AskUserQuestion: 'AskUserQuestion',
  ExitPlanMode: 'ExitPlanMode',
  NotebookEdit: 'NotebookEdit',
  PowerShell: 'PowerShell',
  Monitor: 'Monitor',
  CronCreate: 'CronCreate',
  CronList: 'CronList',
  CronDelete: 'CronDelete',
  Config: 'Config',
  SlashCommand: 'SlashCommand',
  DiscoverSlashCommands: 'DiscoverSlashCommands',
} as const

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES]

export const ALL_CC_TOOL_NAMES: readonly ToolName[] =
  Object.values(TOOL_NAMES)

/** cc's classification of read-only vs. write tools. Used by plan mode. */
export const CC_READ_ONLY_TOOLS: ReadonlySet<ToolName> = new Set([
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'AskUserQuestion',
  'TodoWrite', // metadata-only mutation
  'BashOutput', // reading bg job output is read-only
  'Agent', // sub-agent runs under its own permission mode
  'CronList', // listing only
  'DiscoverSlashCommands', // listing only
  'Config', // safe — gated by supportedSettings whitelist
])

export const CC_WRITE_TOOLS: ReadonlySet<ToolName> = new Set([
  'Bash',
  'KillShell',
  'Write',
  'Edit',
  'NotebookEdit',
  'ExitPlanMode',
  'PowerShell',
  'Monitor', // spawns a process — not safe in plan mode
  'CronCreate', // schedules future side effects
  'CronDelete', // removes scheduled work
  'SlashCommand', // expands an arbitrary template; could include Bash/Edit
])

/**
 * cc's exact tool descriptions (as of v1.11.x). These are passed straight
 * to the Anthropic API, so the wording matters — model behaviour is
 * sensitive to specific phrases like "Performs exact string replacements".
 */
export const TOOL_DESCRIPTIONS = {
  Bash: `Executes a given bash command and returns its output.

The working directory persists between commands, but shell state does not. The shell environment is initialized from the user's profile (bash or zsh).

IMPORTANT: Avoid using this tool to run \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\` commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user:

 - Read files: Use Read (NOT cat/head/tail)
 - Edit files: Use Edit (NOT sed/awk)
 - Write files: Use Write (NOT echo >/cat <<EOF)
 - Communication: Output text directly (NOT echo/printf)
While the Bash tool can do similar things, it's better to use the built-in tools as they provide a better user experience and make it easier to review tool calls and give permission.

# Instructions
 - If your command will create new directories or files, first use this tool to run \`ls\` to verify the parent directory exists and is the correct location.
 - Always quote file paths that contain spaces with double quotes in your command.
 - Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of \`cd\`.
 - You may specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). By default, your command will timeout after 120000ms (2 minutes).
 - You can use the \`run_in_background\` parameter to run the command in the background. Only use this if you don't need the result immediately and are OK being notified when the command completes later. Read the output later via BashOutput.
 - When issuing multiple commands, prefer to make multiple Bash tool calls in a single message rather than chaining with \`;\` or \`&&\`, since the harness can show each one's output independently.
 - Avoid unnecessary \`sleep\` commands. Use BashOutput to poll a background job rather than sleeping in the foreground.`,

  BashOutput: `Read output from a background Bash command (one started with run_in_background=true).

Returns new output since the last call, the current status (running/exited), and the exit code if it has finished.`,

  KillShell: `Kill a running background Bash command by its shell_id. Use this when a long-running command is no longer needed.`,

  Read: `Reads a file from the local filesystem. You can access any file directly by using this tool.
Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- By default, it reads up to 2000 lines starting from the beginning of the file
- When you already know which part of the file you need, only read that part. This can be important for larger files.
- Results are returned using cat -n format, with line numbers starting at 1
- This tool can read Jupyter notebooks (.ipynb files) and returns all cells with their outputs.
- This tool can only read files, not directories. To list files in a directory, use the registered shell tool.
- You will regularly be asked to read screenshots. If the user provides a path to a screenshot, ALWAYS use this tool to view the file at the path. This tool will work with all temporary file paths.
- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.`,

  Write: `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.
- Prefer the Edit tool for modifying existing files — it only sends the diff. Only use this tool to create new files or for complete rewrites.
- NEVER create documentation files (*.md) or README files unless explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.`,

  Edit: `Performs exact string replacements in files.

Usage:
- You must use your \`Read\` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + tab. Everything after that is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if \`old_string\` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use \`replace_all\` to change every instance of \`old_string\`.
- Use \`replace_all\` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.`,

  Glob: `Fast file pattern matching tool that works with any codebase size.

- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time (most recently modified first)
- Use this tool when you need to find files by name patterns
- When you are doing an open-ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead.`,

  Grep: `A powerful search tool built on top of ripgrep.

Usage:
- Always use Grep for search tasks. NEVER invoke \`grep\` or \`rg\` as a Bash command. The Grep tool has been optimized for correct permissions and access.
- Supports full regex syntax (eg. "log.*Error", "function\\\\s+\\\\w+")
- Filter files with the glob parameter (eg. "*.js", "**/*.tsx") or type parameter (eg. "js", "py", "rust")
- Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts
- Use Task tool for open-ended searches requiring multiple rounds
- Pattern syntax: Uses ripgrep (not grep) — literal braces need escaping (use \`interface\\\\{\\\\}\` to find \`interface{}\` in Go code)
- Multiline matching: By default patterns match within single lines only. For cross-line patterns like \`struct \\\\{[\\\\s\\\\S]*?field\`, use \`multiline: true\``,

  WebFetch: `Fetches content from a specified URL and processes it.

- Takes a URL and a prompt as input
- Fetches the URL content, converts HTML to markdown
- Use this tool when the user provides you with a URL or you need to read documentation
- The URL must be a fully-formed valid URL
- HTTP URLs will be automatically upgraded to HTTPS where supported
- For security: only http and https URLs are allowed; redirects are followed within the same scheme
- This tool is read-only and does not modify any files
- Results may be summarized if the content is very large. Include a specific prompt about what you need from the page.`,

  WebSearch: `Allows Claude to search the web and use the results to inform responses.

- Provides up-to-date information for current events and recent data
- Returns search result information formatted as search result blocks
- Use this tool for accessing information beyond Claude's knowledge cutoff
- Results may include sources you can then fetch with WebFetch for detail`,

  TodoWrite: `Use this tool to create and manage a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.

## When to Use This Tool
Use this tool proactively in these scenarios:

1. Complex multi-step tasks — When a task requires 3 or more distinct steps or actions
2. Non-trivial and complex tasks — Tasks that require careful planning or multiple operations
3. User explicitly requests todo list — When the user directly asks you to use the todo list
4. User provides multiple tasks — When users provide a list of things to be done (numbered or comma-separated)
5. After receiving new instructions — Immediately capture user requirements as todos
6. When you start working on a task — Mark it as in_progress BEFORE beginning work. Ideally you should only have one todo as in_progress at a time
7. After completing a task — Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
1. There is only a single, straightforward task
2. The task is trivial and tracking it provides no organizational benefit
3. The task can be completed in less than 3 trivial steps
4. The task is purely conversational or informational

## Task States and Management

1. **Task States**: Use these states to track progress:
   - pending: Task not yet started
   - in_progress: Currently working on (limit to ONE task at a time)
   - completed: Task finished successfully

   **IMPORTANT**: Task descriptions must have two forms:
   - content: The imperative form describing what needs to be done (e.g., "Run tests", "Build the project")
   - activeForm: The present continuous form shown during execution (e.g., "Running tests", "Building the project")

2. **Task Management**:
   - Update task status in real-time as you work
   - Mark tasks complete IMMEDIATELY after finishing (don't batch completions)
   - Exactly ONE task must be in_progress at any time (not less, not more)
   - Complete current tasks before starting new ones
   - Remove tasks that are no longer relevant from the list entirely

3. **Task Completion Requirements**:
   - ONLY mark a task as completed when you have FULLY accomplished it
   - If you encounter errors, blockers, or cannot finish, keep the task as in_progress
   - When blocked, create a new task describing what needs to be resolved
   - Never mark a task as completed if tests are failing, implementation is partial, you encountered unresolved errors, or you couldn't find necessary files or dependencies

When in doubt, use this tool.`,

  Agent: `Launch a new agent to handle complex, multi-step tasks. Each agent type has specific capabilities and tools available to it.

When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries, use this tool to perform the search for you.

When using the Agent tool, specify a subagent_type parameter to select which agent type to use.

## When to use the Agent tool
- Open-ended search ("where is X defined?", "find every caller of Y")
- Cross-file investigations spanning multiple rounds of grep/read
- Tasks that would otherwise pollute your context with intermediate tool output

## When NOT to use the Agent tool
- A specific known file path — use Read directly.
- A specific symbol — use Grep directly.
- Reading a single file — use Read directly.

## Usage notes
- When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently.
- Each agent invocation is stateless. The sub-agent does not see this conversation; pass it everything it needs in the prompt.
- The agent returns a single final message. The result is not visible to the user — relay anything important yourself in your reply.
- Clearly tell the agent whether to write code or just to research, since it does not see the user's intent.
- If the agent description mentions it should be used proactively, use it without the user having to ask.`,

  AskUserQuestion: `Ask the user one or more multiple-choice questions to disambiguate their request.

Use this tool when:
- The user's request is genuinely ambiguous and the right answer changes the plan.
- You need to choose between two or more reasonable interpretations.

Don't use it for:
- Single-answer factual lookups.
- Questions you can answer yourself by reading code.
- Confirming destructive actions (the harness handles that separately).

Limits: ≤ 5 questions per call, each with 2-6 short options.`,

  ExitPlanMode: `Use this tool to exit plan mode and submit your plan to the user for approval.

You should only call this tool once you have written your plan and are ready to execute it. The user must approve the plan before you start making changes.`,

  PowerShell: `Run a PowerShell command and return its output. Windows-native equivalent of Bash with a persistent shell — Set-Location, $env:VAR, and module imports carry across calls. Prefer dedicated tools (Read/Edit/Glob/Grep) over PowerShell when possible.`,

  Monitor: `Start a long-running background process whose stdout/stderr stream to a file. Use for "watch X and let me know when it changes" tasks (tail -f, polling loops, file watchers). Returns a shell_id and an output file path; you'll get a system-reminder when the process exits.`,

  CronCreate: `Schedule a future agent invocation. The agent gets a fresh turn with the given prompt at the scheduled time. Schedule formats: ISO date, "in N units", "every N units", "@hourly", "@daily".`,

  CronList: `List all pending scheduled jobs (id, schedule, next fire time, prompt preview).`,

  CronDelete: `Remove a scheduled cron job by id. Stops repeating jobs immediately.`,

  Config: `Get or set a whitelisted Claude Code configuration setting. Pass only \`key\` to read, or \`key\` + \`value\` to write. Writes are NOT hot-reloaded — the running agent keeps its old config until re-created.`,

  SlashCommand: `Invoke a user-defined custom command from .claude/commands/. Returns the EXPANDED prompt template (with $ARGUMENTS substituted, !bash inlined, @file inlined). Treat the result as instructions you should follow. Use DiscoverSlashCommands first if you don't know what's available.`,

  DiscoverSlashCommands: `List user-defined custom commands installed in .claude/commands/. Returns name + description for each.`,

  NotebookEdit: `Modify a Jupyter notebook (.ipynb) cell.

Modes:
- replace (default): replace cell_id's source with new_source.
- insert: insert a new cell at the position of cell_id (or at the end if cell_id is null). cell_type must be specified.
- delete: delete cell_id.

Notes:
- notebook_path must be ABSOLUTE.
- The notebook is loaded, modified, and atomically rewritten on each call.
- For text edits within a single cell, prefer Edit on the underlying .ipynb (it's JSON) only when you need a partial change; otherwise use NotebookEdit's replace mode for clarity.`,
} as const satisfies Record<ToolName, string>
