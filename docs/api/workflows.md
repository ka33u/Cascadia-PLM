# Lifecycles API

> **Paths:** these routes live at `/api/v1/lifecycles`. `/api/v1/lifecycles`,
> the path they shipped under, stays mounted as a deprecated alias with the
> same handlers; the response keys keep their v1 spelling (`workflows`,
> `workflow`). Readers arriving from Aras or Windchill: what other systems
> call a workflow is a lifecycle definition of the Driving kind here — see the
> [lifecycle engine guide](../features/workflow-engine.md#coming-from-aras-or-windchill).

The Lifecycles API manages lifecycle definitions: the state machines that govern item states and the review and release of change orders. Instances, transitions and approvals on a change order are served by the [Change Orders API](./change-orders.md).

A definition's `lifecycleType` says what kind it is:

- **Free** -- self-controlled; items transition by hand (Issues, Tasks, Work Orders)
- **Driven** -- change-order-controlled; a release applies its change actions (Parts, Documents, Requirements)
- **Driving** -- a change order's own review and release process (`Change Order - Standard`, `XCO - Flexible Change Order`)

`?type=workflow` selects the Driving definitions and `?type=lifecycle` the rest; `?lifecycleType=` selects one kind by name.

## Endpoints

This page explains behaviour; it is not an endpoint inventory. Three generated
surfaces carry that, and none of them can drift from the routes the way a
hand-written table does:

- `GET /api/docs` — the interactive Scalar UI
- `GET /openapi.json` — the live spec, regenerated from route metadata per request
- [`openapi.v1.json`](./openapi.v1.json) — the frozen v1 contract, the one external
  consumers should build against

See [the API README](./README.md) for the versioning policy that governs all three.

For lifecycle instances on change orders, see the [Change Orders API](./change-orders.md).

## List Lifecycle Definitions

```
GET /api/v1/lifecycles
```

Lists all lifecycle definitions with optional filtering. Requires `lifecycles.read` permission.

### Query Parameters

| Parameter       | Type    | Values                      | Description                                         |
| --------------- | ------- | --------------------------- | --------------------------------------------------- |
| `isActive`      | string  | `true`, `false`             | Filter by active status                             |
| `type`          | string  | `lifecycle`, `workflow`     | `workflow` = Driving, `lifecycle` = Driven and Free |
| `lifecycleType` | string  | `Free`, `Driven`, `Driving` | Filter by kind                                      |
| `limit`         | integer | 1-500                       | Max results (default 100)                           |
| `offset`        | integer | 0+                          | Pagination offset (default 0)                       |

### Response

```json
{
  "data": {
    "workflows": [
      {
        "id": "def-uuid",
        "name": "Standard Part Lifecycle",
        "lifecycleType": "Driven",
        "workflowType": "strict",
        "description": "Standard lifecycle for manufactured parts",
        "applicableItemTypes": ["Part", "Document"],
        "states": [
          { "id": "draft", "name": "Draft", "isInitial": true },
          { "id": "in-review", "name": "In Review" },
          { "id": "released", "name": "Released", "isFinal": true }
        ],
        "transitions": [
          {
            "id": "t1",
            "name": "Submit for Review",
            "fromStateId": "draft",
            "toStateId": "in-review"
          },
          {
            "id": "t2",
            "name": "Release",
            "fromStateId": "in-review",
            "toStateId": "released"
          }
        ],
        "isActive": true,
        "createdAt": "2025-01-01T00:00:00.000Z"
      }
    ],
    "total": 5
  }
}
```

### Example

```bash
# List the active item lifecycles (Driven and Free)
curl /api/v1/lifecycles?isActive=true&type=lifecycle

# List the change-order lifecycles (Driving)
curl /api/v1/lifecycles?type=workflow

# One kind by name
curl /api/v1/lifecycles?lifecycleType=Driven
```

## Create Lifecycle Definition

```
POST /api/v1/lifecycles
```

Creates a new lifecycle definition. Requires `lifecycles.create` permission.

### Request Body

| Field                 | Type    | Required | Description                                     |
| --------------------- | ------- | -------- | ----------------------------------------------- |
| `name`                | string  | Yes      | Definition name                                 |
| `lifecycleType`       | string  | No       | `Free` (default), `Driven`, or `Driving`        |
| `workflowType`        | string  | No       | `strict` (default) or `flexible`                |
| `description`         | string  | No       | Description                                     |
| `applicableItemTypes` | array   | No       | Item types this lifecycle applies to            |
| `states`              | array   | No       | Array of state definitions                      |
| `transitions`         | array   | No       | Array of transition definitions                 |
| `isActive`            | boolean | No       | Whether the definition is active (default true) |

### State Definition

| Field       | Type    | Required       | Description                                                                                              |
| ----------- | ------- | -------------- | -------------------------------------------------------------------------------------------------------- |
| `id`        | string  | Yes            | Unique state identifier                                                                                  |
| `name`      | string  | Yes            | Display name                                                                                             |
| `isInitial` | boolean | No             | True for the starting state                                                                              |
| `isFinal`   | boolean | No             | True for terminal states                                                                                 |
| `finalKind` | string  | Driving finals | `release` or `cancel`: what completing here means. Required on every final state of a Driving definition |
| `color`     | string  | No             | Display color                                                                                            |

### Transition Definition

| Field         | Type   | Required | Description                  |
| ------------- | ------ | -------- | ---------------------------- |
| `id`          | string | No       | Unique transition identifier |
| `name`        | string | Yes      | Display name                 |
| `fromStateId` | string | Yes      | Source state ID              |
| `toStateId`   | string | Yes      | Target state ID              |
| `guards`      | array  | No       | Guard conditions             |

### Example

```bash
curl -X POST /api/v1/lifecycles \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Change Order - Two-Step Review",
    "lifecycleType": "Driving",
    "workflowType": "strict",
    "description": "Change-order review with a rework loop",
    "applicableItemTypes": ["ChangeOrder"],
    "states": [
      { "id": "Draft", "name": "Draft", "isInitial": true },
      { "id": "InReview", "name": "In Review" },
      { "id": "Approved", "name": "Approved", "isFinal": true, "finalKind": "release" },
      { "id": "Rejected", "name": "Rejected", "isFinal": true, "finalKind": "cancel" }
    ],
    "transitions": [
      {
        "name": "Submit for Review",
        "fromStateId": "Draft",
        "toStateId": "InReview"
      },
      {
        "name": "Approve",
        "fromStateId": "InReview",
        "toStateId": "Approved"
      },
      {
        "name": "Reject",
        "fromStateId": "InReview",
        "toStateId": "Rejected"
      },
      {
        "name": "Return to Draft",
        "fromStateId": "InReview",
        "toStateId": "Draft"
      }
    ]
  }'
```

**Status:** `201 Created`

## Get Lifecycle Definition

```
GET /api/v1/lifecycles/:id
```

Returns a single lifecycle definition by ID. Requires `lifecycles.read` permission.

### Response

```json
{
  "data": {
    "workflow": {
      "id": "def-uuid",
      "name": "Standard Part Lifecycle",
      "lifecycleType": "Driven",
      "workflowType": "strict",
      "description": "...",
      "applicableItemTypes": ["Part", "Document"],
      "states": [...],
      "transitions": [...],
      "isActive": true,
      "createdAt": "2025-01-01T00:00:00.000Z",
      "updatedAt": "2025-01-10T12:00:00.000Z"
    }
  }
}
```

## Update Lifecycle Definition

```
PUT /api/v1/lifecycles/:id
```

Updates a lifecycle definition. Requires `lifecycles.manage` permission.

### Request Body

All fields are optional:

```json
{
  "name": "Updated Lifecycle",
  "description": "Updated description",
  "applicableItemTypes": ["Part", "Document", "Requirement"],
  "states": [...],
  "transitions": [...],
  "isActive": true
}
```

## Delete Lifecycle Definition

```
DELETE /api/v1/lifecycles/:id
```

Deletes a lifecycle definition. Requires `lifecycles.manage` permission. Refused while an active instance or an item type still references it.

### Response

```json
{
  "data": {
    "success": true
  }
}
```

## Approvers

### Get All Approvers

```
GET /api/v1/lifecycles/:id/approvers
```

Returns approvers configured for all states in a lifecycle definition. Requires `lifecycles.read` permission. The write endpoints below require `lifecycles.manage`; `PUT .../states/:stateId/approvers` replaces a state's whole approver set and `PATCH .../approvers/:approverId` changes one approver's `isRequired`.

### Response

```json
{
  "data": {
    "approvers": [
      {
        "stateId": "in-review",
        "stateName": "In Review",
        "approvers": [
          {
            "id": "approver-uuid",
            "userId": "user-uuid",
            "roleId": "role-uuid",
            "userName": "Jane Smith",
            "roleName": "Engineering Lead"
          }
        ]
      }
    ]
  }
}
```

### Get State Approvers

```
GET /api/v1/lifecycles/:id/states/:stateId/approvers
```

Returns approvers for a specific lifecycle state.

### Add Approver

```
POST /api/v1/lifecycles/:id/states/:stateId/approvers
```

Adds an approver (user or role) to a lifecycle state.

### Request Body

```json
{
  "type": "user",
  "id": "user-uuid",
  "isRequired": true
}
```

`type` is `user` or `role`, `id` is that user's or role's id, and `isRequired` (default `true`) says whether the approval is required or advisory.

### Remove Approver

```
DELETE /api/v1/lifecycles/:id/states/:stateId/approvers/:approverId
```

Removes an approver from a lifecycle state.

## Strict and Flexible Definitions

The `workflowType` property (`strict` or `flexible`) says whether an instance may carry a structure of its own. It is orthogonal to `lifecycleType`, the definition's kind.

### Strict

Strict definitions enforce that transitions can only follow the defined state machine. All states and transitions are fixed at definition time.

### Flexible

Flexible definitions allow per-instance customization of states and transitions. When a lifecycle instance is started from a flexible definition, the instance gets its own copy of states and transitions that can be modified.

Use `PUT /api/v1/change-orders/:id/workflow/structure` to modify the structure of a flexible lifecycle instance.

## Guards

Transitions can have guard conditions that must be met before the transition is allowed:

| Guard Type    | Config                                           | Description                                                                           |
| ------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `field_value` | `fieldName`, `operator`, `value`                 | A field of the item must satisfy the operator (equals, is_not_empty, greater_than, …) |
| `user_role`   | `requiredRoles`, `requireAll` (default: any one) | The actor must hold one of the roles, or all of them                                  |

Guards are evaluated against the change order itself by `GET /api/v1/change-orders/:id/workflow/transition`, which reports each transition's `canTransition` and `guardResults`; approval votes are a separate mechanism (state approvers), not a guard.

## Change-Order-Driven Item State

Affected items change state through their Driven lifecycle's `changeActionMappings`, applied by the merge when a change order completes in a `finalKind: 'release'` state — never through per-transition configuration. (The former `lifecycleEffects` transition field was removed in remediation Phase 3; see `docs/features/workflow-engine.md` for the mappings model.)

## Lifecycle Instance Endpoints

Lifecycle instances are managed through the Change Orders API. See the [Change Orders API](./change-orders.md) for:

- `GET /api/v1/change-orders/:id/workflow` -- get instance
- `POST /api/v1/change-orders/:id/workflow` -- start instance
- `GET /api/v1/change-orders/:id/workflow/transition` -- available transitions
- `POST /api/v1/change-orders/:id/workflow/transition` -- execute transition
- `GET /api/v1/change-orders/:id/workflow/history` -- transition history
- `GET /api/v1/change-orders/:id/approvals` -- approval status
- `POST /api/v1/change-orders/:id/approvals` -- submit vote
