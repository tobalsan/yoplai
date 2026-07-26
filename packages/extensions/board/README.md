# Board Extension

The `board` extension adds the Board workspace API and shared scratchpad tools.
It is built in, but it only loads when configured in `yoplai.json`.

## Minimal Config

Enable Board with defaults:

```json
{
  "extensions": {
    "board": {}
  }
}
```

By default, Board stores user content in `$YOPLAI_HOME`. The shared scratchpad
file is:

```text
$YOPLAI_HOME/SCRATCHPAD.md
```

## Custom Content Root

Set `contentRoot` when Board content should live outside `$YOPLAI_HOME`:

```json
{
  "extensions": {
    "board": {
      "contentRoot": "~/yoplai-board"
    }
  }
}
```

Board will create the directory if needed and store:

```text
~/yoplai-board/SCRATCHPAD.md
```

## Home Route

Board claims the home route by default:

```json
{
  "extensions": {
    "board": {
      "home": true
    }
  }
}
```

Disable home-route ownership if another extension should own `/`:

```json
{
  "extensions": {
    "board": {
      "home": false
    }
  }
}
```

Only one loaded extension can set `home: true`.

## Disable Board

Use `enabled: false` to keep config in place without loading the extension:

```json
{
  "extensions": {
    "board": {
      "enabled": false
    }
  }
}
```

## Full Example

```json
{
  "extensions": {
    "board": {
      "contentRoot": "~/yoplai-board",
      "home": true
    }
  }
}
```

## Projects Settings

Board has no project-storage settings of its own. Configure projects through the
separate `projects` extension:

```json
{
  "extensions": {
    "board": {},
    "projects": {
      "root": "~/projects"
    }
  }
}
```

The `projects.root` value controls where project folders, areas, archives, and
project workspaces live. If omitted, projects default to `~/projects`.

## API

Gateway routes are mounted under `/api/board`:

```http
GET /api/board/info
GET /api/board/agents
GET /api/board/projects
GET /api/board/scratchpad
PUT /api/board/scratchpad
GET /api/board/canvas/:agentId
POST /api/board/canvas/:agentId
```

`GET /api/board/projects?profile=true` adds an `X-Profile-Ms` header with
handler wall time. Project scans are cached in memory with stale refresh; tune
the defaults with `YOPLAI_BOARD_PROJECTS_CACHE_TTL_MS`,
`YOPLAI_BOARD_REPO_WORKTREE_TTL_MS`, `YOPLAI_BOARD_BRANCH_CACHE_TTL_MS`, and
`YOPLAI_BOARD_DIRTY_AHEAD_TTL_MS`.

## Agent Tools

Board contributes scratchpad guidance and tools to agents:

```text
scratchpad.read
scratchpad.write
scratchpad.read_lines
scratchpad.insert_lines
scratchpad.replace_lines
scratchpad.delete_lines
```

Prefer the line-level tools for edits. They reduce the chance of clobbering
concurrent scratchpad changes.
