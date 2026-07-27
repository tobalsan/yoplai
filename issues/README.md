# Kanban slice refactor — issues

Historical local issue sequence for the completed kanban slice refactor. The superseded source spec was removed during documentation cleanup; the numbered issue files retain the implementation plan.

## Dependency graph

```
01 storage primitives ──┬─> 02 CLI add/list/get
                        ├─> 03 SCOPE_MAP gen ──> 04 CLI mutations
                        ├─> 05 project status refactor
                        └─> 10 projects ext slice kanban

02 CLI add/list/get ────────────────────────────> 10
03 SCOPE_MAP ───────────────────────────────────> 06 migration
04 CLI mutations ───────────────────────────────> 08 dispatcher+worker
                                                  10
05 project status ──────────────────────────────> 06 migration
                                                  08 dispatcher+worker
                                                  11 board project list
                                                  12 board project detail
                                                  14 activity feed

07 SubagentRun schema ──────────────────────────> 08
                                                  09 reviewer
                                                  13 agents view
                                                  14 activity feed

08 dispatcher+worker ───────────────────────────> 09 reviewer

10 projects ext kanban ─────────────────────────> 12 board project detail

01–14 ──────────────────────────────────────────> 15 docs + e2e smoke
```

## Suggested execution order

1. `01` storage primitives
2. `07` SubagentRun schema (parallel with 01; independent)
3. `02` CLI add/list/get
4. `03` SCOPE_MAP gen
5. `05` project status refactor (parallel with 03)
6. `04` CLI mutations
7. `06` migration command
8. `08` dispatcher + worker rekey
9. `09` reviewer rekey
10. `10` projects ext slice kanban
11. `11` board project list (parallel with 10)
12. `12` board project detail
13. `13` agents view (parallel with 12)
14. `14` activity feed (parallel with 12/13)
15. `15` docs + e2e smoke
