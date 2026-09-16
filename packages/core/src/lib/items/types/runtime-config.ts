// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Runtime-configurable fields for item types.
 * These can be modified without code changes or redeployment.
 *
 * This interface is kept separate from database schema to avoid
 * pulling database dependencies into client bundles.
 */
export interface RuntimeItemTypeConfig {
  label?: string
  pluralLabel?: string
  icon?: string
  /**
   * Links this item type to a lifecycle definition (from workflow_definitions table).
   * The lifecycle controls which states are valid and how items transition between them.
   * Multiple item types can share the same lifecycle definition.
   *
   * Validation rules:
   * - Cannot change to a lifecycle that doesn't include current items' states
   * - Cannot delete a lifecycle that item types reference
   * - Cannot remove states from a lifecycle that items are currently in
   */
  lifecycleDefinitionId?: string
  permissions?: {
    create: Array<string>
    read: Array<string>
    update: Array<string>
    delete: Array<string>
  }
  relationships?: Array<{
    type: string
    label: string
    targetTypes: Array<string>
    allowMultiple: boolean
  }>
  fieldMetadata?: Record<
    string,
    {
      label?: string
      description?: string
      required?: boolean
      visible?: boolean
    }
  >
  /**
   * ChangeOrder only: the Driving definition each change type runs. Creation
   * starts that definition's instance, so every change type an install
   * creates needs an entry.
   */
  lifecyclesByChangeType?: LifecyclesByChangeType
  /**
   * The key this shipped under. Read for one release — a config written by
   * an older client or a database not yet migrated still says it — and
   * never written: `ConfigService` moves it to `lifecyclesByChangeType` on
   * the way in and out (remediation plan CM-25).
   * @deprecated
   */
  workflowsByChangeType?: LifecyclesByChangeType
}

export interface LifecyclesByChangeType {
  ECO?: string
  ECN?: string
  Deviation?: string
  MCO?: string
  XCO?: string
}
