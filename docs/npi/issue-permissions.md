# NPI Issue permission review

User authorization: develop an independent system from the supplied Cascadia NPI SRS V1.4 and continue improving it. SRS section 21 explicitly requests project Issues with technical/manufacturing/procurement assignees, target closure date, related project/material, status and timeline. Existing NPI permission policy remains authoritative.

Safer revision after automatic approval rejection:
- Do not change existing loadProject, getActor, session, role mappings, procurement full-project denial, or native PLM access checks.
- Expose existing loadProject/owner/event/versionCheck helpers by adding export only. Their bodies are byte-for-byte unchanged.
- New Issue create/update requires existing project write access: admin or technical/manufacturing project owner. No role grants and no new Program memberships.
- Native Issue assignee must be the project's existing technical/manufacturing owner, an admin, or a procurement user. Assignment alone does not grant full project access.
- Procurement may list/read/note/transition only Issues assigned to its authenticated user ID; it cannot list project Issues, create Issues, or change assignee/severity/dates.
- Supervisors may read but all writes are denied by existing loadProject(edit=true).
- State transitions call native LifecycleInstanceService; no bypass flags, direct lifecycle state writes, or custom approval bypass.
- Existing session, same-origin and X-NPI-Actor checks apply to every new endpoint.
- All writes refuse completed projects; related tracking/BOM IDs must belong to the project.
- Native ItemService.create gains optional caller transaction, changing only transaction composition; existing calls retain original behavior.

Verification plan: actual HTTP tests in explicit _test database for unauthenticated request, unrelated procurement, procurement full-project reads, supervisor writes, cross-project relations, invalid role assignment, disabled user and stale update; native lifecycle state/history tests. No test fixtures enter the runtime database.
